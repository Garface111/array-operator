# Intake Filter for CC-Verification / TEST Submissions

Filter rule (to be added to review intake pipeline):
- If body starts with `TEST` or contains `cc-verify@example.com` pattern → auto-drop (do not promote to reviewed queue).

This prevents test submissions from reaching Sovereign ops review/build stages. No UI or Excel change needed (per feature review).