# Improve OK Shape Check 2 - Implementation Plan

**Feature**: #36 - improve-ok-shape-check-2  
**Date**: 2026-07-13  
**Status**: Research & Planning

## Context

The owner request "improve-ok-shape-check-2" is a follow-up to earlier shape validation work. Based on the codebase context:

- The app is `array-operator` (owner-web), a solar array monitoring dashboard
- Recent work includes UI theme refinements (sky theme, day/night modes)
- The codebase shows sophisticated CSS motion systems, glass morphism, and accessibility features
- Previous "shape check" work likely relates to data validation or UI component rendering

## Interpretation

"OK shape check" most likely refers to:

1. **Data shape validation** - Ensuring API responses/inverter data match expected structures
2. **UI component rendering** - Verifying components render correctly across different states
3. **Layout validation** - Checking responsive layouts maintain correct "shape" across viewports

## Safe Implementation Options

Without access to the original shape check implementation or specific bug reports, here are defensible improvements:

### Option A: CSS Shape Integrity (Safest)

Add validation for the glass morphism effects and ensure consistent border-radius/backdrop-filter across themes:

```css
/* Validate glass material consistency */
html.sky .tabbar,
html.sky .ao-modal-layer {
  /* Ensure backdrop-filter is never accidentally disabled */
  backdrop-filter: blur(24px) saturate(1.5);
  -webkit-backdrop-filter: blur(24px) saturate(1.5);
}

/* Defensive: prevent shape collapse when empty */
html.sky .sb-inv:empty::after {
  content: '';
  display: block;
  min-height: 48px;
}
```

### Option B: Focus Visible Shape (High Value)

The current `:focus-visible` implementation in styles.css (line ~40) provides keyboard navigation indicators. Improve its "shape" to be more consistent:

```css
/* Enhanced focus shape - consistent across all themes */
:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
  border-radius: 4px;
}

html[data-theme="day"] :focus-visible {
  outline-color: var(--good);
}

html.sky :focus-visible {
  outline-color: rgba(37, 99, 235, 0.8);
}
```

### Option C: Motion System Shape Guard

The codebase has a sophisticated motion system. Add guardrails to prevent animation "shape" breaking:

```css
/* Prevent transform collapse during animation */
@media (prefers-reduced-motion: no-preference) {
  [data-animating] {
    will-change: transform, opacity;
  }
  
  [data-animating]:not([data-animating=""])::after {
    /* Maintain layout space during transform */
    content: '';
    display: block;
  }
}
```

## Recommended Action

**Without the original "shape-check-1" code or a specific bug report**, the safest approach is:

1. **Document the expected behavior** (this file)
2. **Add defensive CSS** for known glass morphism edge cases
3. **Wait for owner clarification** before implementing data-layer changes

## Questions for Owner

1. What was "improve-ok-shape-check-1"? (Need to understand the baseline)
2. Is this about:
   - API response validation?
   - Component rendering?
   - CSS layout integrity?
   - Something else?
3. Is there a specific bug or edge case this should fix?

## Next Steps

- [x] Document interpretation and safe options
- [ ] Await owner clarification on specific improvement target
- [ ] Implement targeted fix once scope is clear
- [ ] Mark #36 as shipped in admin status after implementation

---

**Agent Note**: This brief lacks sufficient context to safely implement a product change. The term "shape check" could refer to many different systems. Rather than guess and risk breaking working code, I've documented the likely interpretations and safe improvement options. The owner should clarify whether this relates to data validation, UI rendering, or layout before code changes ship.
