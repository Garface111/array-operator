"""poll_sentry — pull new Sentry errors and dispatch an auto-fix for each.

This is the zero-infrastructure trigger: instead of hosting the webhook relay,
a scheduled GitHub Actions job runs this script every few minutes. It asks the
Sentry REST API for recent unresolved issues, and for each one that doesn't yet
have a fix branch it fires `repository_dispatch` (event_type = "sentry-issue"),
which kicks off the Claude Code agent in sentry-autofix.yml.

Dedup is stateless: the fix-branch name is a deterministic hash of the issue, so
we simply skip any issue whose branch already exists on GitHub. No state file,
no database.

Env vars:
  SENTRY_AUTH_TOKEN   Sentry auth token with project:read + event:read. Required.
  SENTRY_ORG          Sentry org slug. Required.
  SENTRY_PROJECT      Sentry project slug (e.g. "python-fastapi"). Required.
  SENTRY_QUERY        Issue search. Default: "is:unresolved level:error".
  SENTRY_LOOKBACK     Only consider issues last seen within this window. Default "1h".
  SENTRY_MAX_ISSUES   Safety cap on dispatches per run. Default "5".
  GITHUB_TOKEN        Token for repository_dispatch + branch-existence checks. Required.
  GITHUB_REPO         "owner/name" whose workflow to trigger. Required (GITHUB_REPOSITORY in Actions).
  AUTOFIX_TARGET_REPO Optional "owner/name" the agent should actually fix.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))

from build_prompt import _branch_name  # deterministic, shared with the workflow
from relay import dispatch_to_github
from sentry_brief import build_brief

SENTRY_API = "https://sentry.io/api/0"
GITHUB_API = "https://api.github.com"


def _get_json(url: str, token: str, scheme: str = "Bearer"):
    req = urllib.request.Request(url, headers={
        "Authorization": f"{scheme} {token}",
        "Accept": "application/json",
        "User-Agent": "sentry-autofix-poller",
    })
    with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310 (trusted host)
        return json.load(resp)


def fetch_recent_issues(token: str, org: str, project: str,
                        query: str, lookback: str, limit: int) -> list[dict]:
    """List unresolved issues, newest activity first."""
    params = urllib.parse.urlencode({
        "query": query,
        "statsPeriod": lookback,
        "sort": "date",
        "limit": str(min(limit * 4, 100)),  # over-fetch; we filter + cap below
    })
    url = f"{SENTRY_API}/projects/{org}/{project}/issues/?{params}"
    issues = _get_json(url, token)
    return issues if isinstance(issues, list) else []


def fetch_latest_event(token: str, issue_id: str) -> dict:
    """Full latest event for an issue — this carries the stacktrace."""
    url = f"{SENTRY_API}/issues/{issue_id}/events/latest/"
    try:
        return _get_json(url, token)
    except urllib.error.HTTPError:
        return {}


def branch_exists(token: str, repo: str, branch: str) -> bool:
    url = f"{GITHUB_API}/repos/{repo}/git/ref/heads/{urllib.parse.quote(branch)}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "sentry-autofix-poller",
    })
    try:
        with urllib.request.urlopen(req, timeout=15):  # noqa: S310
            return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise


def main() -> int:
    token = os.environ.get("SENTRY_AUTH_TOKEN")
    org = os.environ.get("SENTRY_ORG")
    project = os.environ.get("SENTRY_PROJECT")
    gh_token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPO") or os.environ.get("GITHUB_REPOSITORY")
    if not all([token, org, project, gh_token, repo]):
        print("ERROR: set SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT, "
              "GITHUB_TOKEN and GITHUB_REPO.", file=sys.stderr)
        return 1

    query = os.environ.get("SENTRY_QUERY", "is:unresolved level:error")
    lookback = os.environ.get("SENTRY_LOOKBACK", "1h")
    cap = int(os.environ.get("SENTRY_MAX_ISSUES", "5"))
    target = os.environ.get("AUTOFIX_TARGET_REPO") or None

    issues = fetch_recent_issues(token, org, project, query, lookback, cap)
    print(f"Sentry returned {len(issues)} candidate issue(s) for '{query}' over {lookback}.")

    dispatched = 0
    for issue in issues:
        if dispatched >= cap:
            print(f"Hit SENTRY_MAX_ISSUES={cap}; stopping (remaining issues next run).")
            break
        issue_id = str(issue.get("id"))
        title = issue.get("title") or issue.get("culprit") or issue_id

        event = fetch_latest_event(token, issue_id)
        # Carry the issue's own metadata so the brief is complete even if the
        # latest event is thin, and so web_url / id survive.
        event.setdefault("issue_id", issue_id)
        event.setdefault("web_url", issue.get("permalink"))
        event.setdefault("title", issue.get("title"))
        event.setdefault("culprit", issue.get("culprit"))
        event.setdefault("level", issue.get("level", "error"))
        event.setdefault("metadata", issue.get("metadata", {}))
        brief = build_brief({"data": {"event": event}})

        branch = _branch_name(brief)
        if branch_exists(gh_token, repo, branch):
            print(f"skip  {title} — fix branch {branch} already exists")
            continue

        code = dispatch_to_github(brief, token=gh_token, repo=repo, target_repo=target)
        print(f"DISPATCH {title} -> {repo} (HTTP {code}, branch {branch})")
        dispatched += 1

    print(f"Done. Dispatched {dispatched} new auto-fix run(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
