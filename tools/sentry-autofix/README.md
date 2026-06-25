# Sentry Auto-Fix

An automated pipeline that turns a Sentry production error into a reviewed pull
request. When Sentry fires an alert, a **Claude Code agent** identifies the root
cause, writes the fix, adds a regression test, runs the suite, and opens a PR.

This was built in response to errors like the one that motivated it —
`IntegrityError: (psycopg2.errors.UniqueViolation) duplicate key value violates
unique constraint "uq_daily_array_day"` on `POST /v1/array-owners/inverter-capture`.

## How it flows

```
Sentry Issue Alert (webhook action)
   │  POST, HMAC-signed
   ▼
relay.py  ──►  GitHub repository_dispatch  (event_type = "sentry-issue")
                       │  client_payload = normalized brief
                       ▼
        .github/workflows/sentry-autofix.yml
                       │  build_prompt.py renders the agent prompt
                       ▼
        anthropics/claude-code-action  (the agent: identify → fix → test → PR)
```

## Files

| File | Role |
| --- | --- |
| `sentry_brief.py` | Normalizes any Sentry payload shape into a small, stable brief. Picks the real in-app culprit frame over library frames. |
| `relay.py` | Webhook receiver. Verifies Sentry's signature and fires `repository_dispatch`. Runs standalone **or** mounts into the existing FastAPI backend (`include_router`). |
| `build_prompt.py` | Renders the agent prompt + a stable fix-branch name from the brief. Used by the workflow. |
| `test_sentry_brief.py` | Tests, including the real `uq_daily_array_day` payload. |
| `../../.github/workflows/sentry-autofix.yml` | The GitHub Actions job that runs the agent. |

## Setup

### 1. GitHub secrets (repo → Settings → Secrets → Actions)

| Secret | Purpose |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | **Recommended.** Uses your Claude Pro/Max **subscription** instead of metered API billing. Generate locally with `claude setup-token` and paste the result. The token expires periodically — regenerate and update the secret when it does. |
| `ANTHROPIC_API_KEY` | Alternative to the OAuth token: a metered Anthropic API key. Used only if `CLAUDE_CODE_OAUTH_TOKEN` is unset. Provide **one** of these two. |
| `AUTOFIX_GH_TOKEN` | PAT with `repo` + `workflow` scope. Needed so the agent can open PRs (and to fix a **different** target repo, e.g. the backend). Falls back to the default `GITHUB_TOKEN` for same-repo fixes. |

> **Subscription vs API key.** With `CLAUDE_CODE_OAUTH_TOKEN`, automated runs draw
> on your Claude Code usage limits — keep `AUTOFIX_MIN_LEVEL` and the workflow's
> per-issue `concurrency` group in place so an error storm can't burn your quota.

### 2. Deploy the relay

Pick one:

- **Mount into the FastAPI backend (recommended — no extra service):**
  ```python
  from tools.sentry_autofix.relay import router as sentry_autofix_router
  app.include_router(sentry_autofix_router)   # exposes POST /sentry/webhook
  ```
- **Run standalone:**
  ```bash
  pip install fastapi uvicorn
  SENTRY_CLIENT_SECRET=... GITHUB_TOKEN=... python -m tools.sentry-autofix.relay
  ```

Relay environment variables:

| Var | Default | Notes |
| --- | --- | --- |
| `SENTRY_CLIENT_SECRET` | — | Internal-integration client secret. **Set in prod** or signatures aren't verified. |
| `GITHUB_TOKEN` | — | Token used for `repository_dispatch`. **Required.** |
| `GITHUB_REPO` | `garface111/array-operator` | Repo whose workflow to trigger. |
| `AUTOFIX_TARGET_REPO` | — | Repo the agent should actually fix, if different (e.g. `garface111/python-fastapi-backend`). |
| `AUTOFIX_MIN_LEVEL` | `error` | Skip issues below this level (`debug`/`info`/`warning`/`error`/`fatal`). |

### 3. Wire up Sentry

1. **Settings → Developer Settings → New Internal Integration.**
2. Webhook URL: `https://<your-host>/sentry/webhook`. Enable the **issue & error** webhooks. Copy the **Client Secret** into `SENTRY_CLIENT_SECRET`.
3. **Alerts → Create Alert → Issues** → when *a new issue is created* (and/or level ≥ error) → action **Send a notification via** the integration above.

## Testing without Sentry

- **Unit tests:** `python -m pytest tools/sentry-autofix/` (or run the file directly).
- **Manual workflow run:** Actions → *Sentry Auto-Fix* → *Run workflow* → paste a
  raw Sentry payload or a brief JSON into `payload`. Set `target_repo` to fix a
  different repo.
- **Local prompt preview:**
  ```bash
  PYTHONPATH=tools/sentry-autofix python tools/sentry-autofix/build_prompt.py \
    --payload "$(cat sample_payload.json)" --out-dir /tmp
  ```

## Safety model

- The agent is told to **fix the cause, not silence the symptom** — e.g. make an
  upsert idempotent rather than widen or drop a unique constraint.
- It opens a **PR for human review**; it never pushes to the default branch.
- If the trace points outside the repo, or a fix needs a migration / large
  refactor, it documents the diagnosis and stops instead of forcing a change.
- The relay verifies Sentry's HMAC signature and rate-limits by issue via the
  workflow `concurrency` group, so a noisy error can't spawn duplicate PRs.
