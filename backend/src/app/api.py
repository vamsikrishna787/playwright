"""REST API (API Gateway HTTP API -> this Lambda).

Long-running work (script generation with Bedrock, test runs) is handed to the
worker Lambda with an async invoke; the UI polls the status endpoints.
"""

import base64
import hmac
import json
import os
import re
import traceback
from concurrent.futures import ThreadPoolExecutor

import boto3

from . import store

API_TOKEN = os.environ.get("API_TOKEN", "")
WORKER_FUNCTION = os.environ.get("WORKER_FUNCTION", "")
lambda_client = boto3.client("lambda")
pool = ThreadPoolExecutor(max_workers=16)

DATA_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")

ARTIFACTS = {
    "video.webm": ("Video", "video/webm"),
    "screenshot.png": ("Final screenshot", "image/png"),
    "trace.zip": ("Playwright trace", "application/zip"),
    "report.zip": ("Playwright HTML report", "application/zip"),
    "results.json": ("Playwright results (JSON)", "application/json"),
    "output.log": ("Runner log", "text/plain"),
    "lighthouse.html": ("Lighthouse report (HTML)", "text/html"),
    "lighthouse.json": ("Lighthouse report (JSON)", "application/json"),
}


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def response(status, body=None):
    return {
        "statusCode": status,
        # CORS headers are added by the HTTP API (CorsConfiguration in infra/app.yaml).
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body if body is not None else {}),
    }


def read_body(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode()
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        raise HttpError(400, "Body must be JSON")
    if not isinstance(body, dict):
        raise HttpError(400, "Body must be a JSON object")
    return body


# ---------------------------------------------------------------- validation

def clean_str(value, field, max_len, required=False):
    value = (value or "").strip() if isinstance(value, (str, type(None))) else None
    if value is None:
        raise HttpError(400, f"{field} must be a string")
    if required and not value:
        raise HttpError(400, f"{field} is required")
    if len(value) > max_len:
        raise HttpError(400, f"{field} is too long (max {max_len})")
    return value


def clean_url(value, field, required=False):
    value = clean_str(value, field, 2000, required)
    if value and not value.startswith(("http://", "https://")):
        raise HttpError(400, f"{field} must start with http:// or https://")
    return value


def validate_suite(body, existing=None):
    suite = dict(existing or {})
    suite["name"] = clean_str(body.get("name", suite.get("name")), "name", 120, required=True)
    suite["description"] = clean_str(body.get("description", suite.get("description")), "description", 2000)
    suite["baseUrl"] = clean_url(body.get("baseUrl", suite.get("baseUrl")), "baseUrl")
    return suite


def validate_test(body, suite, existing=None):
    test = dict(existing or {})
    test["name"] = clean_str(body.get("name", test.get("name")), "name", 160, required=True)
    test["description"] = clean_str(body.get("description", test.get("description")), "description", 4000)
    test["startUrl"] = clean_str(body.get("startUrl", test.get("startUrl")), "startUrl", 2000)
    test["expectedResult"] = clean_str(body.get("expectedResult", test.get("expectedResult")), "expectedResult", 4000)

    steps = body.get("steps", test.get("steps", []))
    if not isinstance(steps, list) or len(steps) > 100:
        raise HttpError(400, "steps must be a list of at most 100 items")
    test["steps"] = [clean_str(s, f"steps[{i}]", 2000) for i, s in enumerate(steps)]
    test["steps"] = [s for s in test["steps"] if s]

    points = body.get("dataPoints", test.get("dataPoints", []))
    if not isinstance(points, list) or len(points) > 100:
        raise HttpError(400, "dataPoints must be a list of at most 100 items")
    cleaned, seen = [], set()
    for i, dp in enumerate(points):
        if not isinstance(dp, dict):
            raise HttpError(400, f"dataPoints[{i}] must be an object")
        key = clean_str(dp.get("key"), f"dataPoints[{i}].key", 64)
        if not key:
            continue
        if not DATA_KEY_RE.match(key):
            raise HttpError(400, f"Data point key '{key}' must be a valid identifier (letters, digits, underscore)")
        if key in seen:
            raise HttpError(400, f"Duplicate data point key '{key}'")
        seen.add(key)
        cleaned.append({"key": key, "value": clean_str(dp.get("value"), f"dataPoints[{i}].value", 4000)})
    test["dataPoints"] = cleaned

    if not store.resolve_start_url(suite, test).startswith(("http://", "https://")):
        raise HttpError(400, "Provide an absolute start URL, or set a base URL on the suite")
    return test


# ---------------------------------------------------------------- loaders

def load_suite(suite_id):
    if not store.ID_RE.match(suite_id):
        raise HttpError(404, "Suite not found")
    suite = store.get_json(store.suite_prefix(suite_id) + "suite.json")
    if not suite:
        raise HttpError(404, "Suite not found")
    return suite


def load_test(suite_id, test_id):
    if not store.ID_RE.match(test_id):
        raise HttpError(404, "Test not found")
    test = store.get_json(store.test_prefix(suite_id, test_id) + "test.json")
    if not test:
        raise HttpError(404, "Test not found")
    return test


def run_ids(suite_id, test_id):
    names = store.list_child_names(store.test_prefix(suite_id, test_id) + "runs/")
    return sorted((n for n in names if store.RUN_ID_RE.match(n)), reverse=True)


def load_run(suite_id, test_id, run_id):
    run = store.get_json(store.run_prefix(suite_id, test_id, run_id) + "run.json")
    if run:
        run["status"] = store.effective_job_status(run)
    return run


def summarize_test(suite, test):
    prefix = store.test_prefix(suite["id"], test["id"])
    generation = store.get_json(prefix + "generation.json")
    script = store.get_json(prefix + "script.json")
    ids = run_ids(suite["id"], test["id"])
    last_run = load_run(suite["id"], test["id"], ids[0]) if ids else None

    gen_status = store.effective_job_status(generation)
    if gen_status in ("queued", "running"):
        script_status = "generating"
    elif script:
        script_status = "stale" if script.get("definitionHash") != store.definition_hash(suite, test) else "ready"
    elif gen_status in ("failed", "error"):
        script_status = "failed"
    else:
        script_status = "none"

    return {
        **test,
        "resolvedStartUrl": store.resolve_start_url(suite, test),
        "scriptStatus": script_status,
        "generation": generation and {
            "jobId": generation.get("jobId"),
            "status": gen_status,
            "error": generation.get("error"),
            "queuedAt": generation.get("queuedAt"),
            "finishedAt": generation.get("finishedAt"),
        },
        "script": script,
        "lastRun": last_run,
        "runCount": len(ids),
    }


def list_tests(suite):
    names = [n for n in store.list_child_names(store.suite_prefix(suite["id"]) + "tests/") if store.ID_RE.match(n)]
    tests = list(pool.map(lambda tid: store.get_json(store.test_prefix(suite["id"], tid) + "test.json"), names))
    tests = [t for t in tests if t]
    summaries = list(pool.map(lambda t: summarize_test(suite, t), tests))
    return sorted(summaries, key=lambda t: t.get("createdAt", ""))


def suite_rollup(tests):
    counts = {"total": len(tests), "ready": 0, "generating": 0, "noScript": 0, "passed": 0, "failed": 0, "running": 0}
    for t in tests:
        if t["scriptStatus"] in ("ready", "stale"):
            counts["ready"] += 1
        elif t["scriptStatus"] == "generating":
            counts["generating"] += 1
        else:
            counts["noScript"] += 1
        last_run = t.get("lastRun") or {}
        run_status = last_run.get("status")
        if last_run.get("lighthouseStatus") == "running":
            counts["running"] += 1
        elif run_status == "passed":
            counts["passed"] += 1
        elif run_status in ("failed", "error"):
            counts["failed"] += 1
        elif run_status in ("queued", "running"):
            counts["running"] += 1

    if not tests:
        status = "empty"
    elif counts["running"] or counts["generating"]:
        status = "running"
    elif counts["failed"]:
        status = "failing"
    elif counts["passed"] == counts["total"]:
        status = "passing"
    else:
        status = "not-run"
    return {"status": status, "counts": counts}


# ---------------------------------------------------------------- worker dispatch

def invoke_worker(payload):
    lambda_client.invoke(
        FunctionName=WORKER_FUNCTION,
        InvocationType="Event",
        Payload=json.dumps(payload).encode(),
    )


def start_generation(suite, test):
    prefix = store.test_prefix(suite["id"], test["id"])
    current = store.get_json(prefix + "generation.json")
    if store.effective_job_status(current) in ("queued", "running"):
        raise HttpError(409, "A script generation is already in progress for this test")
    job = {
        "jobId": store.new_id(),
        "status": "queued",
        "queuedAt": store.now_iso(),
        "definitionHash": store.definition_hash(suite, test),
        "log": [],
    }
    store.put_json(prefix + "generation.json", job)
    invoke_worker({"action": "generate", "suiteId": suite["id"], "testId": test["id"], "jobId": job["jobId"]})
    return job


def start_run(suite, test, options, trigger="manual"):
    prefix = store.test_prefix(suite["id"], test["id"])
    if not store.get_json(prefix + "script.json"):
        raise HttpError(400, "Generate a script for this test before running it")
    preset = options.get("lighthousePreset", "desktop")
    if preset not in ("desktop", "mobile"):
        raise HttpError(400, "lighthousePreset must be desktop or mobile")
    run = {
        "runId": store.new_run_id(),
        "status": "queued",
        "queuedAt": store.now_iso(),
        "trigger": trigger,
        "lighthouse": bool(options.get("lighthouse", True)),
        "lighthousePreset": preset,
    }
    store.put_json(store.run_prefix(suite["id"], test["id"], run["runId"]) + "run.json", run)
    invoke_worker({"action": "run", "suiteId": suite["id"], "testId": test["id"], "runId": run["runId"]})
    return run


# ---------------------------------------------------------------- handlers

def list_suites(_event):
    names = [n for n in store.list_child_names("suites/") if store.ID_RE.match(n)]
    suites = [s for s in pool.map(lambda sid: store.get_json(store.suite_prefix(sid) + "suite.json"), names) if s]

    def with_rollup(suite):
        return {**suite, **suite_rollup(list_tests(suite))}

    # Suites are summarised one after another; each one fans out over its tests on the shared pool.
    result = [with_rollup(s) for s in suites]
    return 200, sorted(result, key=lambda s: s.get("createdAt", ""))


def create_suite(event):
    suite = validate_suite(read_body(event))
    suite.update({"id": store.new_id(), "createdAt": store.now_iso(), "updatedAt": store.now_iso()})
    store.put_json(store.suite_prefix(suite["id"]) + "suite.json", suite)
    return 201, suite


def get_suite(_event, suite_id):
    suite = load_suite(suite_id)
    tests = list_tests(suite)
    return 200, {**suite, **suite_rollup(tests), "tests": tests}


def update_suite(event, suite_id):
    suite = validate_suite(read_body(event), load_suite(suite_id))
    suite["updatedAt"] = store.now_iso()
    store.put_json(store.suite_prefix(suite_id) + "suite.json", suite)
    return 200, suite


def delete_suite(_event, suite_id):
    load_suite(suite_id)
    store.delete_prefix(store.suite_prefix(suite_id))
    return 200, {"deleted": suite_id}


def run_suite(event, suite_id):
    suite = load_suite(suite_id)
    options = read_body(event)
    started, skipped = [], []
    for test in list_tests(suite):
        if test["scriptStatus"] in ("ready", "stale") and (test.get("lastRun") or {}).get("status") not in ("queued", "running"):
            started.append({"testId": test["id"], **start_run(suite, test, options, trigger="suite")})
        else:
            skipped.append({"testId": test["id"], "reason": f"script {test['scriptStatus']}"})
    return 202, {"started": started, "skipped": skipped}


def create_test(event, suite_id):
    suite = load_suite(suite_id)
    test = validate_test(read_body(event), suite)
    test.update({"id": store.new_id(), "suiteId": suite_id, "createdAt": store.now_iso(), "updatedAt": store.now_iso()})
    store.put_json(store.test_prefix(suite_id, test["id"]) + "test.json", test)
    return 201, summarize_test(suite, test)


def get_test(_event, suite_id, test_id):
    suite = load_suite(suite_id)
    test = load_test(suite_id, test_id)
    summary = summarize_test(suite, test)
    ids = run_ids(suite_id, test_id)[:25]
    summary["runs"] = [r for r in pool.map(lambda rid: load_run(suite_id, test_id, rid), ids) if r]
    summary["suite"] = suite
    return 200, summary


def update_test(event, suite_id, test_id):
    suite = load_suite(suite_id)
    test = validate_test(read_body(event), suite, load_test(suite_id, test_id))
    test["updatedAt"] = store.now_iso()
    store.put_json(store.test_prefix(suite_id, test_id) + "test.json", test)
    return 200, summarize_test(suite, test)


def delete_test(_event, suite_id, test_id):
    load_suite(suite_id)
    load_test(suite_id, test_id)
    store.delete_prefix(store.test_prefix(suite_id, test_id))
    return 200, {"deleted": test_id}


def generate_test(_event, suite_id, test_id):
    suite = load_suite(suite_id)
    test = load_test(suite_id, test_id)
    return 202, start_generation(suite, test)


def get_generation(_event, suite_id, test_id):
    load_suite(suite_id)
    load_test(suite_id, test_id)
    job = store.get_json(store.test_prefix(suite_id, test_id) + "generation.json")
    if not job:
        raise HttpError(404, "No generation has been started for this test")
    job["status"] = store.effective_job_status(job)
    return 200, job


def get_script(_event, suite_id, test_id):
    load_suite(suite_id)
    test = load_test(suite_id, test_id)
    prefix = store.test_prefix(suite_id, test_id)
    code = store.get_text(prefix + "script.spec.ts")
    draft = store.get_text(prefix + "draft.spec.ts")
    if code is None and draft is None:
        raise HttpError(404, "No script has been generated yet")
    filename = re.sub(r"[^A-Za-z0-9_-]+", "-", test["name"]).strip("-").lower() or "test"
    return 200, {
        "code": code,
        "meta": store.get_json(prefix + "script.json"),
        "draft": draft,
        "downloadUrl": code is not None and store.presign(prefix + "script.spec.ts", f"{filename}.spec.ts"),
    }


def run_test(event, suite_id, test_id):
    suite = load_suite(suite_id)
    test = load_test(suite_id, test_id)
    return 202, start_run(suite, test, read_body(event))


def get_run(_event, suite_id, test_id, run_id):
    load_suite(suite_id)
    load_test(suite_id, test_id)
    if not store.RUN_ID_RE.match(run_id):
        raise HttpError(404, "Run not found")
    run = load_run(suite_id, test_id, run_id)
    if not run:
        raise HttpError(404, "Run not found")
    prefix = store.run_prefix(suite_id, test_id, run_id)
    artifacts = []
    for f in store.list_files(prefix):
        name = f["key"][len(prefix):]
        if name not in ARTIFACTS:
            continue
        label, content_type = ARTIFACTS[name]
        artifacts.append({
            "name": name,
            "label": label,
            "contentType": content_type,
            "size": f["size"],
            "viewUrl": store.presign(f["key"]),
            "downloadUrl": store.presign(f["key"], f"{run_id}-{name}"),
        })
    order = list(ARTIFACTS)
    run["artifacts"] = sorted(artifacts, key=lambda a: order.index(a["name"]))
    return 200, run


ROUTES = [
    ("GET", r"/suites", list_suites),
    ("POST", r"/suites", create_suite),
    ("GET", r"/suites/(\w+)", get_suite),
    ("PUT", r"/suites/(\w+)", update_suite),
    ("DELETE", r"/suites/(\w+)", delete_suite),
    ("POST", r"/suites/(\w+)/run", run_suite),
    ("POST", r"/suites/(\w+)/tests", create_test),
    ("GET", r"/suites/(\w+)/tests/(\w+)", get_test),
    ("PUT", r"/suites/(\w+)/tests/(\w+)", update_test),
    ("DELETE", r"/suites/(\w+)/tests/(\w+)", delete_test),
    ("POST", r"/suites/(\w+)/tests/(\w+)/generate", generate_test),
    ("GET", r"/suites/(\w+)/tests/(\w+)/generation", get_generation),
    ("GET", r"/suites/(\w+)/tests/(\w+)/script", get_script),
    ("POST", r"/suites/(\w+)/tests/(\w+)/run", run_test),
    ("GET", r"/suites/(\w+)/tests/(\w+)/runs/([\w-]+)", get_run),
]
COMPILED = [(m, re.compile(f"^{p}/?$"), fn) for m, p, fn in ROUTES]


def handler(event, _context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "/")
    if method == "OPTIONS":
        return response(204)

    # Optional access gate. Off by default: the app is public and Bedrock uses the worker's IAM role.
    if API_TOKEN:
        supplied = (event.get("headers") or {}).get("x-api-token", "")
        if not hmac.compare_digest(supplied, API_TOKEN):
            return response(401, {"error": "Missing or invalid API token"})

    try:
        path_matched = False
        for route_method, pattern, fn in COMPILED:
            match = pattern.match(path)
            if not match:
                continue
            path_matched = True
            if route_method == method:
                status, body = fn(event, *match.groups())
                return response(status, body)
        raise HttpError(405 if path_matched else 404, "Not found" if not path_matched else "Method not allowed")
    except HttpError as err:
        return response(err.status, {"error": err.message})
    except Exception:  # noqa: BLE001 - return JSON (with CORS headers) instead of a bare 500
        traceback.print_exc()
        return response(500, {"error": "Internal error, see the API Lambda logs"})
