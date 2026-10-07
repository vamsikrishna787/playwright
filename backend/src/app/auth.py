"""Email sign-in for the API.

Users sign in with their email address. In "code" mode (default) we email a 6-digit code through
Amazon SES and only issue a session after the code is entered, so nobody can open another person's
workspace by typing their address. In "email" mode the address is trusted as-is (for development,
or while SES is still in sandbox).

Sessions are stateless: base64url(json {"e": email, "x": expiry}) + "." + HMAC-SHA256 signature.
Each email maps to an opaque owner key; all of that user's data lives under users/{ownerKey}/.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time

import boto3
from botocore.exceptions import ClientError

from . import store

AUTH_MODE = os.environ.get("AUTH_MODE", "code")  # "code" | "email"
SESSION_SECRET = os.environ.get("SESSION_SECRET", "").encode()
FROM_EMAIL = os.environ.get("FROM_EMAIL", "")
APP_URL = os.environ.get("APP_URL", "")
SESSION_TTL = 30 * 24 * 3600
CODE_TTL = 10 * 60
RESEND_AFTER = 30
MAX_ATTEMPTS = 5

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")
ses = boto3.client("sesv2")


class AuthError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def normalize_email(value):
    email = (value or "").strip().lower()
    if len(email) > 254 or not EMAIL_RE.match(email):
        raise AuthError(400, "Enter a valid email address")
    return email


def owner_key(email):
    return hashlib.sha256(f"owner:{email}".encode()).hexdigest()[:24]


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(payload):
    return _b64(hmac.new(SESSION_SECRET, payload.encode(), hashlib.sha256).digest())


def issue_session(email):
    payload = _b64(json.dumps({"e": email, "x": int(time.time()) + SESSION_TTL}).encode())
    return {"token": f"{payload}.{_sign(payload)}", "email": email, "expiresIn": SESSION_TTL}


def verify_session(header):
    """Returns (email, owner_key) for a valid `Authorization: Bearer <token>` header."""
    if not SESSION_SECRET:
        raise AuthError(500, "Sign-in is not configured (SESSION_SECRET missing)")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    payload, _, signature = token.partition(".")
    if not payload or not hmac.compare_digest(signature, _sign(payload)):
        raise AuthError(401, "Please sign in")
    try:
        claims = json.loads(_unb64(payload))
    except ValueError:
        raise AuthError(401, "Please sign in")
    if claims.get("x", 0) < time.time():
        raise AuthError(401, "Your session expired, please sign in again")
    return claims["e"], owner_key(claims["e"])


def _code_key(email):
    return f"auth/codes/{owner_key(email)}.json"


def _code_hash(email, code):
    return hmac.new(SESSION_SECRET, f"code:{email}:{code}".encode(), hashlib.sha256).hexdigest()


def start(body):
    email = normalize_email(body.get("email"))
    if AUTH_MODE == "email":
        return {"mode": "email", **issue_session(email)}

    if not FROM_EMAIL:
        raise AuthError(503, "Email sign-in codes are not configured on this deployment")
    existing = store.get_json(_code_key(email))
    if existing and time.time() - existing.get("sentAt", 0) < RESEND_AFTER:
        raise AuthError(429, f"A code was just sent. Wait {RESEND_AFTER} seconds before requesting another.")
    code = f"{secrets.randbelow(10**6):06d}"
    store.put_json(_code_key(email), {"hash": _code_hash(email, code), "exp": time.time() + CODE_TTL,
                                      "sentAt": time.time(), "attempts": 0})
    try:
        ses.send_email(
            FromEmailAddress=FROM_EMAIL,
            Destination={"ToAddresses": [email]},
            Content={"Simple": {
                "Subject": {"Data": f"Your Browser Automation Lab code: {code}"},
                "Body": {
                    "Text": {"Data": (
                        f"Your sign-in code is {code}\n\nIt expires in 10 minutes.\n\n"
                        f"{APP_URL}\n\nIf you didn't request this, you can ignore this email."
                    )},
                    "Html": {"Data": (
                        "<div style=\"font-family:Inter,system-ui,sans-serif;color:#0d0d0d;max-width:420px\">"
                        "<p style=\"font-size:15px\">Your Browser Automation Lab sign-in code:</p>"
                        f"<p style=\"font-size:32px;font-weight:600;letter-spacing:6px;margin:16px 0\">{code}</p>"
                        "<p style=\"color:#5d5d5d;font-size:13px\">It expires in 10 minutes. "
                        "If you didn't request this, you can ignore this email.</p></div>"
                    )},
                },
            }},
        )
    except ClientError as err:
        store.delete_key(_code_key(email))
        print(f"SES send failed for code sign-in: {err}")
        raise AuthError(502, f"Could not send the sign-in code to {email}. Please try again later.")
    return {"mode": "code", "sent": True, "email": email}


def verify(body):
    email = normalize_email(body.get("email"))
    code = re.sub(r"\D", "", str(body.get("code") or ""))
    record = store.get_json(_code_key(email))
    if not record or record["exp"] < time.time():
        raise AuthError(400, "The code expired. Request a new one.")
    if record["attempts"] >= MAX_ATTEMPTS:
        raise AuthError(429, "Too many attempts. Request a new code.")
    if not hmac.compare_digest(record["hash"], _code_hash(email, code)):
        record["attempts"] += 1
        store.put_json(_code_key(email), record)
        raise AuthError(400, "That code is not correct")
    store.delete_key(_code_key(email))
    return issue_session(email)
