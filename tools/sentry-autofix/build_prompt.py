"""build_prompt — render the Claude Code agent prompt from a Sentry brief.

Invoked by the GitHub Actions workflow. It reads the brief from either:
  * the repository_dispatch event file ($GITHUB_EVENT_PATH -> client_payload.brief), or
  * a raw Sentry payload / brief JSON passed via --payload (manual workflow_dispatch).

Outputs, to stdout as `key=value` lines suitable for $GITHUB_OUTPUT:
  branch=...        a stable, collision-resistant fix branch name
  prompt_file=...   path to a file holding the full agent prompt

The prompt tells the agent to IDENTIFY the root cause, FIX it, add a regression
TEST, run the test suite, and open a PR — the three jobs the user asked for.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys

from sentry_brief import brief_to_markdown, build_brief

PROMPT_TEMPLATE = """You are an automated bug-fix agent triggered by a Sentry production error.
Work autonomously end-to-end: identify the root cause, fix it, prove it with a test, and open a PR.

{brief_md}

## Your task — do these in order

1. **Reproduce / locate.** Open the file(s) at the primary location and the
   in-app stack frames above. Read enough surrounding code to understand the
   real control flow — do not guess from the title alone.

2. **Diagnose the root cause.** State, in one or two sentences, exactly why this
   error fires in production. Distinguish the *symptom* (the exception) from the
   *cause*. For the example class of `IntegrityError / UniqueViolation` on an
   upsert, the cause is almost always a missing idempotency / ON CONFLICT guard
   under concurrent or retried requests — not a need to widen the constraint.

3. **Fix it at the cause.** Make the smallest change that prevents recurrence
   without breaking the intended behaviour. Prefer making the operation
   idempotent / race-safe over swallowing the exception. Match the surrounding
   code style. Do NOT relax data-integrity constraints to silence the error.

4. **Add a regression test.** Write a test that fails against the old code and
   passes with your fix (e.g. it exercises the duplicate/concurrent path). Put
   it next to the existing tests and follow their conventions.

5. **Verify.** Run the project's test suite (or at least the relevant tests) and
   any linter/type-checker. Iterate until green. If you genuinely cannot run the
   tests in this environment, say so explicitly and explain how you verified.

6. **Open a PR** from branch `{branch}` against the default branch. The PR body
   must contain:
   - **Root cause:** …
   - **Fix:** …
   - **Test:** what you added and the command + result proving it passes.
   - **Sentry:** {web_url}
   - A note if any step (e.g. running tests) could not be completed here.
{automerge}
## Guardrails
- If the stack trace points outside this repository, or the fix would require a
  large refactor or a schema migration, do NOT force a change: open a PR (or
  issue) that documents the diagnosis and the proposed fix, and stop.
- Never weaken auth, validation, or DB constraints just to make the error go away.
- Keep the diff tight and reviewable; one logical fix per PR.
"""


def _load_brief(args: argparse.Namespace) -> dict:
    if args.payload:
        data = json.loads(args.payload)
    else:
        event_path = os.environ.get("GITHUB_EVENT_PATH")
        if event_path and os.path.exists(event_path):
            with open(event_path) as fh:
                event = json.load(fh)
            data = (event.get("client_payload") or {})
        else:
            data = json.loads(sys.stdin.read() or "{}")

    # Accept either an already-built brief or a raw Sentry payload.
    if isinstance(data, dict) and "brief" in data and isinstance(data["brief"], dict):
        return data["brief"]
    if isinstance(data, dict) and ("frames" in data or "primary_location" in data):
        return data
    return build_brief(data if isinstance(data, dict) else {})


def _branch_name(brief: dict) -> str:
    base = brief.get("exception_type") or brief.get("title") or "issue"
    slug = re.sub(r"[^a-z0-9]+", "-", str(base).lower()).strip("-")[:32] or "issue"
    seed = "|".join(str(brief.get(k)) for k in ("issue_id", "event_id", "primary_location"))
    short = hashlib.sha1(seed.encode()).hexdigest()[:8]
    return f"sentry-autofix/{slug}-{short}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload", help="raw Sentry payload or brief as JSON string")
    ap.add_argument("--out-dir", default=".")
    args = ap.parse_args()

    brief = _load_brief(args)
    branch = _branch_name(brief)

    # Autonomous mode: when AUTOFIX_AUTOMERGE is truthy, the agent merges its own
    # PR right after verifying the fix. This ships to the target repo's default
    # branch with no human review, so it is opt-in via a repo Variable.
    automerge = ""
    if str(os.environ.get("AUTOFIX_AUTOMERGE", "")).strip().lower() in ("1", "true", "yes", "on"):
        automerge = (
            "\n7. **Merge automatically (autonomous mode is ON).** Only if you made a"
            " confident code fix AND your regression test passed in step 5, merge the"
            " PR you just opened immediately:\n"
            "   `gh pr merge --squash --delete-branch --admin <pr-number>`\n"
            "   Do NOT merge if you only produced a diagnosis, the trace points outside"
            " this repo, the fix needs a migration/large refactor, or any test failed —"
            " in those cases leave the PR open for a human and say why.\n"
        )

    prompt = PROMPT_TEMPLATE.format(
        brief_md=brief_to_markdown(brief),
        branch=branch,
        web_url=brief.get("web_url") or "(no link)",
        automerge=automerge,
    )

    prompt_file = os.path.join(args.out_dir, "sentry-autofix-prompt.md")
    with open(prompt_file, "w") as fh:
        fh.write(prompt)

    out = os.environ.get("GITHUB_OUTPUT")
    lines = [f"branch={branch}", f"prompt_file={prompt_file}",
             f"title={brief.get('title')}"]
    if out:
        with open(out, "a") as fh:
            fh.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
