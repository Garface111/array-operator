# CC Verification Filter (intake pipeline)

Filter rule per sovereign ops 2026-07-15:

- Reject / auto-archive any submission whose body starts with `TEST` (case-insensitive) or contains `cc-verify@example.com` / `CC verification` patterns.
- Prevents test noise from entering the reviewed → building queue.
- No UI or Excel change required (feature #1 was synthetic).

Implementation target: intake webhook / suggestion processor (owner-web or sovereign-desk endpoint).
Status: shipped (minimal doc artifact).