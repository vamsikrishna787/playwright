#!/usr/bin/env python3
"""One-command deploy for E2E AI Test Studio (no local Docker needed).

    python scripts/deploy.py                 # everything (settings come from deploy.config.json)
    python scripts/deploy.py --skip-image    # reuse the newest worker image in ECR
    python scripts/deploy.py --only-frontend # rebuild + upload the UI only

Steps
1. Deploy the build stack (ECR repository + CodeBuild project + artifact bucket).
2. Zip backend/, upload it, and build/push the worker image in CodeBuild (skipped when the
   content-hash tag already exists in ECR).
3. Package and deploy the app stack (S3 buckets, HTTP API, Lambdas).
4. Build the Vite frontend, upload it to the website bucket under the public URL path, and
   route that path on the existing CloudFront distribution (HTTPS on your own domain).

Requirements: Python 3.10+ with boto3, the AWS CLI, Node 20+ and npm, and AWS credentials.
"""

import argparse
import hashlib
import io
import json
import secrets
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from urllib.parse import urlparse

import boto3
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = ROOT / ".deploy"
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6"  # AWS managed CloudFront cache policy


def log(msg):
    print(f"\n==> {msg}", flush=True)


def run(cmd, cwd=None):
    print("   $ " + " ".join("SessionSecret=****" if c.startswith("SessionSecret=") else c for c in cmd), flush=True)
    subprocess.run([shutil.which(cmd[0]) or cmd[0], *cmd[1:]], cwd=cwd, check=True)


def stack_outputs(cfn, name):
    stack = cfn.describe_stacks(StackName=name)["Stacks"][0]
    return {o["OutputKey"]: o["OutputValue"] for o in stack.get("Outputs", [])}


def cfn_deploy(template, stack, region, params, capabilities):
    cmd = ["aws", "cloudformation", "deploy", "--region", region, "--template-file", str(template),
           "--stack-name", stack, "--no-fail-on-empty-changeset", "--capabilities", *capabilities]
    if params:
        cmd += ["--parameter-overrides", *[f"{k}={v}" for k, v in params.items()]]
    run(cmd)


def session_secret():
    """HMAC key for sign-in sessions. Kept in .deploy/ (git-ignored) so redeploys keep users signed in."""
    STATE_DIR.mkdir(exist_ok=True)
    secret_file = STATE_DIR / "session-secret"
    if not secret_file.exists():
        secret_file.write_text(secrets.token_urlsafe(48))
        print(f"   Generated a new session secret in {secret_file}")
    return secret_file.read_text().strip()


def public_path(public_url):
    """'/labs/browserautomationlab/' for https://opensuperlab.com/labs/browserautomationlab/"""
    path = urlparse(public_url).path.strip("/")
    return f"/{path}/" if path else "/"


# ---------------------------------------------------------------- worker image

def worker_sources():
    files = sorted(p for p in (BACKEND / "src").rglob("*") if p.is_file() and "__pycache__" not in p.parts)
    files += sorted(p for p in (BACKEND / "worker").iterdir() if p.is_file())
    return files


def worker_tag(files):
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(BACKEND).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:16]


def image_exists(ecr, repo_name, tag):
    try:
        ecr.describe_images(repositoryName=repo_name, imageIds=[{"imageTag": tag}])
        return True
    except ClientError as err:
        if err.response["Error"]["Code"] in ("ImageNotFoundException", "RepositoryNotFoundException"):
            return False
        raise


def build_worker_image(session, build_out, force):
    ecr = session.client("ecr")
    codebuild = session.client("codebuild")

    files = worker_sources()
    tag = worker_tag(files)
    image_uri = f"{build_out['RepositoryUri']}:{tag}"
    if not force and image_exists(ecr, build_out["RepositoryName"], tag):
        print(f"   Image {image_uri} already exists, skipping build")
        return image_uri

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            zf.write(path, path.relative_to(BACKEND).as_posix())
    session.client("s3").put_object(Bucket=build_out["ArtifactBucketName"], Key="build-src/worker.zip", Body=buf.getvalue())
    print(f"   Uploaded build context ({len(buf.getvalue()) // 1024} KB)")

    build = codebuild.start_build(
        projectName=build_out["BuildProjectName"],
        environmentVariablesOverride=[{"name": "IMAGE_TAG", "value": tag, "type": "PLAINTEXT"}],
    )["build"]
    print(f"   CodeBuild {build['id']} started (the first build takes about 10 minutes)")
    last_phase = None
    while True:
        time.sleep(15)
        build = codebuild.batch_get_builds(ids=[build["id"]])["builds"][0]
        if build["currentPhase"] != last_phase:
            last_phase = build["currentPhase"]
            print(f"   ... {last_phase}", flush=True)
        if build["buildStatus"] != "IN_PROGRESS":
            break
    if build["buildStatus"] != "SUCCEEDED":
        logs = build.get("logs", {}).get("deepLink", "(see the CodeBuild console)")
        sys.exit(f"Worker image build {build['buildStatus']}. Logs: {logs}")
    return image_uri


# ---------------------------------------------------------------- app stack

def allowed_origins(public_url):
    origins = []
    if public_url:
        parsed = urlparse(public_url)
        origins.append(f"{parsed.scheme}://{parsed.netloc}")
        if not parsed.netloc.startswith("www."):
            origins.append(f"{parsed.scheme}://www.{parsed.netloc}")
    return ",".join(origins + ["http://localhost:5173"])


def deploy_app(session, cfg, build_out, image_uri):
    STATE_DIR.mkdir(exist_ok=True)
    packaged = STATE_DIR / "app.packaged.yaml"
    run(["aws", "cloudformation", "package", "--region", cfg["region"],
         "--template-file", str(ROOT / "infra" / "app.yaml"),
         "--s3-bucket", build_out["ArtifactBucketName"], "--s3-prefix", "lambda",
         "--output-template-file", str(packaged)])
    params = {
        "ProjectName": cfg["project"],
        "WorkerImageUri": image_uri,
        "AuthMode": cfg["authMode"],
        "SessionSecret": session_secret(),
        "AppUrl": cfg["publicUrl"],
        "EmailDomain": cfg.get("emailDomain", ""),
        "EmailHostedZoneId": cfg.get("emailHostedZoneId", ""),
        "BedrockModelId": cfg["model"],
        "BedrockEffort": cfg["effort"],
        "BedrockRegion": cfg["region"],
        "WorkerMemoryMb": str(cfg["workerMemoryMb"]),
        "AllowedOrigins": allowed_origins(cfg["publicUrl"]),
    }
    cfn_deploy(packaged, f"{cfg['project']}-app", cfg["region"], params, ["CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND"])
    return stack_outputs(session.client("cloudformation"), f"{cfg['project']}-app")


# ---------------------------------------------------------------- frontend + CloudFront

def deploy_frontend(session, app_out, cfg):
    base_path = public_path(cfg["publicUrl"])
    (FRONTEND / ".env.production.local").write_text(f"VITE_API_URL={app_out['ApiUrl']}\nVITE_BASE_PATH={base_path}\n")
    # `npm ci` wipes node_modules, which fails on Windows while a dev server holds native binaries open.
    fresh = not (FRONTEND / "node_modules").exists() and (FRONTEND / "package-lock.json").exists()
    run(["npm", "ci" if fresh else "install", "--no-audit", "--no-fund"], cwd=FRONTEND)
    run(["npm", "run", "build"], cwd=FRONTEND)

    # The bucket mirrors the public URL path, so CloudFront forwards paths unchanged.
    target = f"s3://{app_out['WebBucketName']}{base_path}"
    dist = FRONTEND / "dist"
    run(["aws", "s3", "sync", str(dist), target, "--delete", "--region", cfg["region"],
         "--exclude", "index.html", "--cache-control", "public,max-age=31536000,immutable"])
    run(["aws", "s3", "cp", str(dist / "index.html"), f"{target}index.html", "--region", cfg["region"],
         "--cache-control", "no-cache", "--content-type", "text/html"])

    if cfg.get("cloudfrontDistributionId"):
        attach_to_cloudfront(session, cfg["cloudfrontDistributionId"], app_out["WebsiteDomain"], base_path, cfg["project"])


def attach_to_cloudfront(session, distribution_id, website_domain, base_path, project):
    """Route <base_path>* on an existing distribution to the S3 website bucket.

    Only adds or updates this app's own origin and cache behavior. The distribution's
    default behavior, other origins and other behaviors are left as they are.
    """
    cf = session.client("cloudfront")
    current = cf.get_distribution_config(Id=distribution_id)
    config, etag = current["DistributionConfig"], current["ETag"]
    before = json.dumps(config, sort_keys=True, default=str)

    origin_id = f"{project}-web"
    origin = {
        "Id": origin_id,
        "DomainName": website_domain,
        "OriginPath": "",
        "CustomHeaders": {"Quantity": 0},
        "CustomOriginConfig": {
            "HTTPPort": 80,
            "HTTPSPort": 443,
            "OriginProtocolPolicy": "http-only",  # S3 website endpoints only speak HTTP
            "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
            "OriginReadTimeout": 30,
            "OriginKeepaliveTimeout": 5,
        },
        "ConnectionAttempts": 3,
        "ConnectionTimeout": 10,
        "OriginShield": {"Enabled": False},
    }
    origins = [o for o in config["Origins"]["Items"] if o["Id"] != origin_id] + [origin]
    config["Origins"] = {"Quantity": len(origins), "Items": origins}

    pattern = base_path.rstrip("/") + "*"
    behavior = {
        "PathPattern": pattern,
        "TargetOriginId": origin_id,
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {"Quantity": 2, "Items": ["HEAD", "GET"],
                           "CachedMethods": {"Quantity": 2, "Items": ["HEAD", "GET"]}},
        "Compress": True,
        "CachePolicyId": CACHING_OPTIMIZED,
        "SmoothStreaming": False,
        "FieldLevelEncryptionId": "",
        "TrustedSigners": {"Enabled": False, "Quantity": 0},
        "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
        "LambdaFunctionAssociations": {"Quantity": 0},
        "FunctionAssociations": {"Quantity": 0},
    }
    behaviors = [b for b in config["CacheBehaviors"].get("Items", []) if b["PathPattern"] != pattern]
    config["CacheBehaviors"] = {"Quantity": len(behaviors) + 1, "Items": [behavior, *behaviors]}

    if json.dumps(config, sort_keys=True, default=str) != before:
        print(f"   Routing {pattern} -> {website_domain} on CloudFront distribution {distribution_id}")
        cf.update_distribution(Id=distribution_id, IfMatch=etag, DistributionConfig=config)
    cf.create_invalidation(DistributionId=distribution_id, InvalidationBatch={
        "Paths": {"Quantity": 1, "Items": [pattern]},
        "CallerReference": str(time.time()),
    })
    print(f"   Invalidated {pattern} (CloudFront changes take a few minutes to propagate)")


# ---------------------------------------------------------------- main

def load_config(args):
    path = ROOT / "deploy.config.json"
    cfg = json.loads(path.read_text()) if path.exists() else {}
    defaults = {"region": "us-east-1", "project": "e2e-studio", "publicUrl": "", "cloudfrontDistributionId": "",
                "model": "us.moonshotai.kimi-k3", "effort": "high", "workerMemoryMb": 3008, "authMode": "email"}
    cfg = {**defaults, **cfg}
    for key in ("region", "project", "model", "effort"):
        if getattr(args, key):
            cfg[key] = getattr(args, key)
    return cfg


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--region", help="override deploy.config.json")
    parser.add_argument("--project", help="override deploy.config.json")
    parser.add_argument("--model", help="Bedrock model id, for example us.moonshotai.kimi-k3")
    parser.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"])
    parser.add_argument("--skip-image", action="store_true", help="reuse the newest image in ECR")
    parser.add_argument("--force-image", action="store_true", help="rebuild even if the tag exists")
    parser.add_argument("--only-frontend", action="store_true")
    args = parser.parse_args()
    cfg = load_config(args)

    session = boto3.Session(region_name=cfg["region"])
    cfn = session.client("cloudformation")
    identity = session.client("sts").get_caller_identity()
    print(f"Deploying '{cfg['project']}' to account {identity['Account']} in {cfg['region']}")

    if args.only_frontend:
        deploy_frontend(session, stack_outputs(cfn, f"{cfg['project']}-app"), cfg)
        return

    log("Build pipeline stack (ECR + CodeBuild)")
    cfn_deploy(ROOT / "infra" / "build.yaml", f"{cfg['project']}-build", cfg["region"],
               {"ProjectName": cfg["project"]}, ["CAPABILITY_IAM"])
    build_out = stack_outputs(cfn, f"{cfg['project']}-build")

    log("Worker image")
    if args.skip_image:
        images = session.client("ecr").describe_images(repositoryName=build_out["RepositoryName"])["imageDetails"]
        newest = max(images, key=lambda i: i["imagePushedAt"])
        image_uri = f"{build_out['RepositoryUri']}:{newest['imageTags'][0]}"
        print(f"   Reusing {image_uri}")
    else:
        image_uri = build_worker_image(session, build_out, args.force_image)

    log("App stack (S3, API Gateway, Lambda)")
    app_out = deploy_app(session, cfg, build_out, image_uri)

    log("Frontend")
    deploy_frontend(session, app_out, cfg)

    (STATE_DIR / "outputs.json").write_text(json.dumps(app_out, indent=2))
    log("Done")
    print(f"   App   : {cfg['publicUrl'] or app_out['WebsiteUrl'] + public_path(cfg['publicUrl'])}")
    print(f"   API   : {app_out['ApiUrl']}")


if __name__ == "__main__":
    main()
