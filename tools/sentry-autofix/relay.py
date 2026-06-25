"""relay — receive a Sentry webhook and trigger the GitHub auto-fix workflow.

Sentry cannot call the GitHub API directly, so this small relay sits in between:

    Sentry Issue Alert (webhook action)
        -> POST /sentry/webhook  (this relay, signature-verified)
        -> GitHub repository_dispatch (event_type = "sentry-issue")
        -> .github/workflows/sentry-autofix.yml runs the Claude Code agent

It can run two ways:

  1. Standalone:   python -m tools.sentry-autofix.relay   (uvicorn on :8099)
  2. Mounted:      from tools.sentry_autofix.relay import router; app.include_router(router)
     (drop it straight into the existing FastAPI backend so no extra service is needed)

Env vars:
  SENTRY_CLIENT_SECRET   Internal-integration client secret (verifies signature). Required in prod.
  GITHUB_TOKEN           PAT/installation token with `repo` scope (dispatch + PRs). Required.
  GITHUB_REPO            "owner/name" to dispatch to. Default: garface111/array-operator
  AUTOFIX_TARGET_REPO    Optional "owner/name" the agent should actually FIX (e.g. the backend).
  AUTOFIX_MIN_LEVEL      Only relay issues at/above this level. Default: "error".
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import urllib.request
from typing import Any

try:  # FastAPI is optional — the verify/dispatch helpers work without it.
    from fastapi import APIRouter, HTTPException, Request

    router = APIRouter()
except Exception:  # pragma: no cover - import guard for non-FastAPI use
    router = None

from .sentry_brief import build_brief

GITHUB_API = "https://api.github.com"
_LEVEL_RANK = {"debug": 0, "info": 1, "warning": 2, "error": 3, "fatal": 4}


def verify_signature(body: bytes, signature: str | None, secret: str | None) -> bool:
    """Constant-time check of Sentry's `sentry-hook-signature` HMAC-SHA256 header.

    If no secret is configured we allow the request (dev convenience) but the
    relay logs a warning at startup so this isn't silently insecure in prod.
    """
    if not secret:
        return True
    if not signature:
        return False
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(digest, signature)


def _level_ok(brief: dict, minimum: str) -> bool:
    return _LEVEL_RANK.get(brief.get("level", "error"), 3) >= _LEVEL_RANK.get(minimum, 3)


def dispatch_to_github(brief: dict, *, token: str, repo: str,
                       target_repo: str | None = None) -> int:
    """Fire a repository_dispatch event carrying the brief as client_payload."""
    payload = {
        "event_type": "sentry-issue",
        "client_payload": {
            "brief": brief,
            "target_repo": target_repo or "",
            "title": brief.get("title"),
            "issue_id": brief.get("issue_id"),
            "web_url": brief.get("web_url"),
        },
    }
    req = urllib.request.Request(
        f"{GITHUB_API}/repos/{repo}/dispatches",
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "sentry-autofix-relay",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 (trusted URL)
        return resp.status


def handle_payload(raw: bytes, headers: dict[str, str]) -> dict[str, Any]:
    """Core logic, framework-agnostic so it is easy to unit-test."""
    secret = os.environ.get("SENTRY_CLIENT_SECRET")
    sig = headers.get("sentry-hook-signature") or headers.get("Sentry-Hook-Signature")
    if not verify_signature(raw, sig, secret):
        return {"ok": False, "status": 401, "reason": "bad signature"}

    payload = json.loads(raw or b"{}")
    brief = build_brief(payload)

    min_level = os.environ.get("AUTOFIX_MIN_LEVEL", "error")
    if not _level_ok(brief, min_level):
        return {"ok": True, "status": 202, "reason": f"below {min_level}, skipped"}

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        return {"ok": False, "status": 500, "reason": "GITHUB_TOKEN not set"}

    repo = os.environ.get("GITHUB_REPO", "garface111/array-operator")
    target = os.environ.get("AUTOFIX_TARGET_REPO") or None
    code = dispatch_to_github(brief, token=token, repo=repo, target_repo=target)
    return {"ok": True, "status": 200, "dispatched": code, "issue": brief.get("title")}


if router is not None:

    @router.post("/sentry/webhook")
    async def sentry_webhook(request: Request):  # pragma: no cover - thin adapter
        raw = await request.body()
        result = handle_payload(raw, dict(request.headers))
        if not result.get("ok"):
            raise HTTPException(status_code=result.get("status", 400),
                                detail=result.get("reason"))
        return result


def _main() -> None:  # pragma: no cover - manual entrypoint
    import uvicorn
    from fastapi import FastAPI

    if not os.environ.get("SENTRY_CLIENT_SECRET"):
        print("WARNING: SENTRY_CLIENT_SECRET unset — signature checks disabled (dev only).")
    app = FastAPI(title="sentry-autofix-relay")
    app.include_router(router)
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8099")))


if __name__ == "__main__":
    _main()
