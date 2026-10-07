"""S3-backed storage for suites, tests, generated scripts and run artifacts.

Layout (all under DATA_BUCKET, per user: users/{ownerKey}/ where ownerKey is derived from the email):

    users/{owner}/suites/{suiteId}/suite.json
    .../tests/{testId}/test.json          test definition (written by the API only)
    .../tests/{testId}/generation.json    latest generation job + live log (API queues, worker updates)
    .../tests/{testId}/script.spec.ts     last verified Playwright script
    .../tests/{testId}/script.json        metadata for the verified script
    .../tests/{testId}/draft.spec.ts      last unverified attempt (when generation fails)
    .../tests/{testId}/runs/{runId}/run.json + artifacts (video, trace, lighthouse, ...)
    auth/codes/{owner}.json               pending sign-in code (hashed)

Each file has a single writer per lifecycle phase, so no read-modify-write races between the API and workers.
"""

import datetime
import hashlib
import json
import os
import re
import uuid
from urllib.parse import urljoin

import boto3
from botocore.exceptions import ClientError

BUCKET = os.environ.get("DATA_BUCKET", "")
s3 = boto3.client("s3")

ID_RE = re.compile(r"^[a-f0-9]{12}$")
RUN_ID_RE = re.compile(r"^\d{8}T\d{6}-[a-f0-9]{6}$")

# A running job older than this is treated as dead (Lambda max runtime is 15 minutes). Queued jobs can
# wait behind the worker concurrency cap for up to the async event age limit (6 hours).
RUNNING_STALE_AFTER_SECONDS = 17 * 60
QUEUED_STALE_AFTER_SECONDS = 6 * 3600 + 17 * 60


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_iso(value):
    if not value:
        return None
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


def age_seconds(value):
    ts = parse_iso(value)
    if ts is None:
        return None
    return (datetime.datetime.now(datetime.timezone.utc) - ts).total_seconds()


def new_id():
    return uuid.uuid4().hex[:12]


def new_run_id():
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S")
    return f"{stamp}-{uuid.uuid4().hex[:6]}"


# ---------------------------------------------------------------- keys

# Every user's data lives under users/{owner}/, where owner is an opaque key derived from their email.
OWNER_RE = re.compile(r"^[a-f0-9]{24}$")


def suites_root(owner):
    if not OWNER_RE.match(owner or ""):
        raise ValueError("invalid owner key")
    return f"users/{owner}/suites/"


def suite_prefix(owner, suite_id):
    return f"{suites_root(owner)}{suite_id}/"


def test_prefix(owner, suite_id, test_id):
    return f"{suite_prefix(owner, suite_id)}tests/{test_id}/"


def run_prefix(owner, suite_id, test_id, run_id):
    return f"{test_prefix(owner, suite_id, test_id)}runs/{run_id}/"


# ---------------------------------------------------------------- primitives

def get_json(key):
    try:
        body = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
    except ClientError as err:
        if err.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None
        raise
    return json.loads(body)


def put_json(key, obj):
    s3.put_object(
        Bucket=BUCKET,
        Key=key,
        Body=json.dumps(obj, indent=2).encode(),
        ContentType="application/json",
    )


def get_text(key):
    try:
        return s3.get_object(Bucket=BUCKET, Key=key)["Body"].read().decode()
    except ClientError as err:
        if err.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None
        raise


def put_text(key, text, content_type="text/plain; charset=utf-8"):
    s3.put_object(Bucket=BUCKET, Key=key, Body=text.encode(), ContentType=content_type)


def put_file(key, path, content_type):
    s3.upload_file(path, BUCKET, key, ExtraArgs={"ContentType": content_type})


def delete_key(key):
    s3.delete_object(Bucket=BUCKET, Key=key)


def list_child_names(prefix):
    """Names of the immediate 'sub-directories' under prefix."""
    names = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            names.append(cp["Prefix"][len(prefix):].rstrip("/"))
    return names


def list_files(prefix):
    files = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            files.append({"key": obj["Key"], "size": obj["Size"]})
    return files


def delete_prefix(prefix):
    keys = [f["key"] for f in list_files(prefix)]
    for i in range(0, len(keys), 1000):
        chunk = keys[i:i + 1000]
        s3.delete_objects(Bucket=BUCKET, Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": True})


def presign(key, download_name=None, expires=3600):
    params = {"Bucket": BUCKET, "Key": key}
    if download_name:
        params["ResponseContentDisposition"] = f'attachment; filename="{download_name}"'
    return s3.generate_presigned_url("get_object", Params=params, ExpiresIn=expires)


# ---------------------------------------------------------------- domain helpers

def resolve_start_url(suite, test):
    start = (test.get("startUrl") or "").strip()
    base = (suite.get("baseUrl") or "").strip()
    if start.startswith(("http://", "https://")):
        return start
    if not base:
        return start
    return urljoin(base if base.endswith("/") else base + "/", start.lstrip("/"))


def definition_hash(suite, test):
    """Hash of everything that affects the generated script.

    Data point *values* are excluded on purpose: scripts read them from TEST_DATA at
    run time, so changing a value does not require regenerating the script.
    """
    material = {
        "startUrl": resolve_start_url(suite, test),
        "steps": test.get("steps", []),
        "expectedResult": test.get("expectedResult", ""),
        "dataKeys": sorted(dp["key"] for dp in test.get("dataPoints", []) if dp.get("key")),
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()[:16]


def test_data(test):
    return {dp["key"]: dp.get("value", "") for dp in test.get("dataPoints", []) if dp.get("key")}


def effective_job_status(job):
    """Report jobs whose worker died (timeout/crash) or never started as errors."""
    if not job:
        return None
    status = job.get("status")
    if status == "running":
        age = age_seconds(job.get("startedAt") or job.get("queuedAt"))
        if age is not None and age > RUNNING_STALE_AFTER_SECONDS:
            return "error"
    elif status == "queued":
        age = age_seconds(job.get("queuedAt"))
        if age is not None and age > QUEUED_STALE_AFTER_SECONDS:
            return "error"
    return status
