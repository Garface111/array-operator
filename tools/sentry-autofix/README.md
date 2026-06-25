# Sentry Auto-Fix

An automated pipeline that turns a Sentry production error into a reviewed pull
request. When Sentry fires an alert, a **Claude Code agent** identifies the root
cause, writes the fix, adds a regression test, runs the suite, and opens a PR.

This was built in response to errors like the one that motivated it —
`IntegrityError: (psycopg2.errors.UniqueViolation) duplicate key value violates
unique constraint "uq_daily_array_day"` on `POST /v1/array-owners/inverter-capture`.

## How it flows

There are two triggers; **the poller needs no server and is the recommended one.**

**A) Scheduled poller (zero infrastructure — recommended)**
```
GitHub Actions cron (every 15 min)  →  poll_sentry.py
   reads the Sentry REST API for new unresolved errors
   →  repository_dispatch (event_type = "sentry-issue")
   →  .github/workflows/sentry-autofix.yml
   →  anthropics/claude-code-action  (identify → fix → test → PR)
```

**B) Webhook relay (lower latency — optional, needs a host)**
```
Sentry Issue Alert (webhook action)  →  relay.py (HMAC-verified)
   →  repository_dispatch  →  same autofix workflow as above
```

Both feed the same `sentry-autofix.yml`. Pick A for hands-off setup; add B later
if you want near-instant fixes instead of up-to-15-minute latency.

## Files

| File | Role |
| --- | --- |
| `sentry_brief.py` | Normalizes any Sentry payload shape into a small, stable brief. Picks the real in-app culprit frame over library frames. |
| `relay.py` | Webhook receiver. Verifies Sentry's signature and fires `repository_dispatch`. Runs standalone **or** mounts into the existing FastAPI backend (`include_router`). |
| `build_prompt.py` | Renders the agent prompt + a stable fix-branch name from the brief. Used by the workflow. |
| `test_sentry_brief.py` | Tests, including the real `uq_daily_array_day` payload. |
| `../../.github/workflows/sentry-autofix.yml` | The GitHub Actions job that runs the agent. |

## Setup — fully automated path (poller)

This is everything needed for "all Sentry errors flow through the system." No
server to run; GitHub does the polling.

### 1. Secrets — repo → Settings → Secrets and variables → Actions → **Secrets**

| Secret | Purpose |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | **Recommended.** Runs the agent on your Claude Pro/Max **subscription** instead of metered API billing. Generate locally with `claude setup-token` and paste the printed token. Expires periodically — regenerate and update when it does. |
| `ANTHROPIC_API_KEY` | Alternative to the OAuth token (metered API key). Used only if the OAuth token is unset. Provide **one** of these two. |
| `SENTRY_AUTH_TOKEN` | Sentry token with **project:read + event:read**. Create at Sentry → Settings → Account → Auth Tokens (or an Org Internal Integration token). Lets the poller read your errors. |
| `AUTOFIX_GH_TOKEN` | **Required for the poller.** A fine-grained or classic PAT with `repo` + `workflow` scope. GitHub deliberately blocks events fired with the default `GITHUB_TOKEN` from triggering other workflows, so the poller's `repository_dispatch` needs a PAT to start the autofix run. The same token lets the agent open PRs (and fix a different target repo). |

### 2. Variables — same page → **Variables** tab

| Variable | Example | Purpose |
| --- | --- | --- |
| `SENTRY_ORG` | `your-org-slug` | Sentry organization slug. |
| `SENTRY_PROJECT` | `python-fastapi` | Sentry project slug to watch. |
| `SENTRY_QUERY` | `is:unresolved level:error` | (optional) which issues qualify. |
| `SENTRY_LOOKBACK` | `1h` | (optional) only consider issues seen in this window. |
| `AUTOFIX_TARGET_REPO` | `owner/backend-repo` | (optional) the repo the agent should **fix**, if it isn't this one. The errors in the screenshot live in the FastAPI backend, so set this to that repo. |
| `AUTOFIX_AUTOMERGE` | `true` | (optional) **autonomous mode.** When `true`, the agent squash-merges its own PR right after its regression test passes — no human review. Leave unset to keep the PR open for review. ⚠️ With no CI on the target repo, this ships AI-written fixes straight to the default branch; the only check is the agent's own test run. |

That's it. The poller (`.github/workflows/sentry-poll.yml`) runs every 15 minutes,
finds new errors, and opens a fix PR for each — deduped so the same issue never
gets two PRs. Tune the cadence by editing the `cron` line.

> **Subscription usage.** With `CLAUDE_CODE_OAUTH_TOKEN`, automated runs draw on
> your Claude Code limits. `SENTRY_MAX_ISSUES` (default 5/run), `SENTRY_QUERY`,
> and the per-issue `concurrency` group keep an error storm from burning quota.

## Setup — optional low-latency path (webhook relay)

Skip this unless you want sub-minute fixes instead of the poller's ≤15 min.

### Deploy the relay

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

### Point Sentry at the relay

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
