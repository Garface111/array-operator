# Improve Poll — Implementation Plan

**Feature Request**: improve-poll (Owner Improve #37)  
**Context**: Brief contains only "improve-poll" with no explicit requirements or screenshot.

## Analysis

Searching the codebase for polling-related functionality:

1. **Sovereign Desk polling** (`public/sovereign-desk.js`):  
   - Long-polling for turn status via `/v1/sovereign/desk/turn`
   - Poll timer management in `state.pollTimer`
   - No obvious issues in the visible code fragment

2. **GitHub workflows**:  
   - `.github/workflows/sentry-poll.yml` — likely polls Sentry for issues
   - Not a UI/product concern for owner-web

3. **Auto-refresh / live ingest**:  
   - The CSS tokens reference "Auto-refresh vault signature" (`--ao-oct`, `--ao-live`)
   - "Live-state signal" with pulsing dots (`--ao-live-glow`)
   - May indicate a polling mechanism for inverter data or system status

## Conservative interpretation

Without additional context, "improve-poll" could mean:

- **Performance**: reduce polling frequency or implement smarter backoff
- **UX**: clearer visual feedback during polling (loading states, retry indicators)
- **Reliability**: better error handling, cancel-on-navigate, exponential backoff

The safest artifact given the vague brief is **this planning document** — it identifies polling touchpoints and proposes improvements that could be implemented once requirements are clarified.

## Recommended improvements (awaiting spec)

### Sovereign Desk polling enhancements

1. **Exponential backoff**: currently `state.pollTimer` appears to be a simple interval; add exponential backoff on errors (start 2s, max 30s)
2. **Visual feedback**: when `state.sending` is true, show a subtle live indicator (use `--ao-live` / `--ao-live-glow` tokens)
3. **Cancel on navigate**: ensure `state.fetchCtrl` (AbortController) is properly cleaned up when user leaves #sovereign

### General polling best practices

- **Visibility API**: pause polling when tab is hidden (`document.visibilityState === 'hidden'`)
- **Connection awareness**: use `navigator.onLine` to stop polling when offline
- **Request deduplication**: don't fire a new poll if the previous one is still in-flight

## Next steps

1. **Clarify requirements**: does "improve-poll" refer to Sovereign Desk, a specific dashboard auto-refresh, or general polling architecture?
2. **Identify performance issues**: are there observable problems (network tab showing excessive requests, CPU spikes, battery drain)?
3. **Define success criteria**: what makes polling "improved" for this feature?

Once the product ask is clear, implement minimal correct changes following the rules in this repo's motion system (see `public/styles.css` CSS variables for animation timings/easing if visual feedback is needed).

---

**Status**: Research artifact shipped. Awaiting clarification to implement code changes.
