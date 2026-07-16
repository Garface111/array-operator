# Improve #31: Live Ingest → Sovereign

**Status**: Research & Planning  
**Date**: 2026-07-13  
**Brief**: `improve-ok-live` — Owner improve proposal #31

## Context

The brief "improve-ok-live" is a terse owner directive without a specific product defect or feature request. Given the context:

- **Repo**: `array-operator` (owner-facing solar monitoring dashboard)
- **Recent work**: Extensive theming system (day/night/sky modes), Sovereign Desk chat UI, auto-refresh vault with live status indicators
- **Live state semantics**: The codebase has a well-defined "live" concept:
  - `--ao-live` CSS variable (green #2ee68a night, #16a34a day) for "working" status
  - Live status dots with pulsing animations
  - Auto-refresh vault showing real-time data
  - Bridge status monitoring in Sovereign Desk

## Interpretation

Without a screenshot or detailed specification, "improve-ok-live" most likely refers to one of:

1. **Live status indicator refinement** — polish the visual treatment of live/working states
2. **Live data ingest flow** — improve how real-time data flows into the dashboard
3. **Live bridge status** — enhance the Sovereign Desk bridge connectivity UI
4. **Live refresh UX** — improve auto-refresh behavior and feedback

## Safe Implementation Path

Since this is a research-only artifact (no clear product defect to fix), the safest approach is to **document the current live state system** and propose targeted improvements that align with the existing design language.

## Current Live State Implementation

### CSS Variables (from `public/styles.css`)
```css
--ao-live:#2ee68a;           /* night mode working green */
--ao-live-glow:rgba(46,230,138,.55);
--ao-live-ink:#34d399;
```

### Day Mode Override (from `public/theme-day.css`)
```css
--ao-live:#16a34a;           /* green-600 working state */
--ao-live-glow:rgba(22,163,74,.5);
--ao-live-ink:#0f9d58;
```

### Sovereign Desk Bridge Status (from `public/sovereign-desk.js`)
- `bridgeStatus` API endpoint: `/v1/sovereign/desk/bridge/status`
- State tracking: `bridgeOnline: null` (tri-state: null/true/false)
- Polling mechanism for real-time updates

## Recommended Improvements (No-Code)

### 1. Visual Consistency
- Ensure all "live" indicators use the same pulsing animation timing
- Standardize the glow effect radius across components
- Verify color contrast meets WCAG AA in both themes

### 2. Motion Refinement
- Live status dots should use `--motion-fast` (140ms) for state changes
- Pulse animation should respect `prefers-reduced-motion`
- Consider subtle scale transform (1.0 → 1.05) for "heartbeat" effect

### 3. Status Hierarchy
- **Live/Working** (green) — active data flow
- **OK/Healthy** (blue `--good`) — system nominal but not actively streaming
- **Warn** (amber) — degraded but functional
- **Fault** (red) — requires attention

### 4. Accessibility
- Add `aria-live="polite"` to status indicators
- Include text labels for screen readers ("Status: Live")
- Ensure keyboard focus states are visible on status controls

## Next Steps

**If this brief requires a code change**, the owner should clarify:
- Which specific "live" component needs improvement?
- Is this about visual polish, performance, or functionality?
- Are there user complaints or metrics driving this?

**For now**, this document serves as the shipped artifact per the agent rules: "if research-only with no safe code change, write a short plan under docs/sovereign/ as a .md file."

---

**Agent Note**: Marking this as delivered. If the owner provides a screenshot or more specific directive, a follow-up implementation can target the exact UI element.
