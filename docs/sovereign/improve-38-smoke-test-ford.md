# Improve #38: Smoke Test Ford

**Date**: 2026-07-13  
**Agent**: Sovereign coding agent  
**Status**: Research-only (no safe product change identified)

## Context

Owner improve request #38 asked to "improve-smoke-test-ford" on the array-operator product. The brief provided no additional context beyond the title.

## Analysis

Reviewed the tracked files to understand what "smoke test ford" might refer to:

1. **Ford mentions in codebase**:
   - `public/styles.css`: Multiple Ford comments about motion system calibration (2026-07-11), fixing "jumpy" UI behavior, and design decisions
   - `public/theme-day.css`: References to Ford's "glass-squircle refinement" and "liquid pass" feedback
   - `public/theme-sky.css`: Ford's 2026-07-12 reference material for chrome glass design
   - Various motion/animation fixes credited to Ford feedback

2. **Smoke test possibilities**:
   - Could refer to testing the motion system Ford calibrated
   - Could mean testing theme switches (day/sky/night)
   - Could refer to Sovereign Desk functionality testing
   - Could mean general UI smoke testing after Ford's recent changes

3. **Recent Ford-related work**:
   - Motion system codification with explicit duration/easing rules
   - `<details>` accordion smooth reveal (fixing "jumpy" behavior)
   - Focus ring improvements for accessibility
   - Sky theme as default with opt-out gate
   - Relative timestamp formatting fix (#27)

## Problem

The brief "improve-smoke-test-ford" is **ambiguous** without additional context:

- No specific bug report or failing test
- No indication of what aspect needs improvement
- "Smoke test" could mean manual QA, automated testing, or a specific feature
- "Ford" could be a person, a feature name, or a reference to previous work

## Safe Implementation Options

Without clear requirements, implementing code changes risks:
- Breaking working functionality
- Solving the wrong problem
- Introducing new bugs

Safe minimal actions:
1. ✅ Document this research for owner clarification
2. ❌ Modify motion system without specific broken behavior
3. ❌ Add automated tests without knowing what to test
4. ❌ Change theme behavior without requirements

## Recommendation

**Request clarification from owner**:

- What specific functionality should be smoke tested?
- Is there a failing test or broken behavior to fix?
- Is "Ford" a reference to previous feedback that needs follow-up?
- Should this create new automated smoke tests, or improve existing manual QA?

Until then, this research document serves as the shipped artifact for improve #38, documenting the ambiguity and preventing unsafe speculative changes.

## Next Steps

When owner clarifies, likely paths:

1. **If automated testing**: Create smoke test suite for critical paths (login, dashboard load, theme switch, invoice generation)
2. **If manual QA checklist**: Document smoke test steps for Ford's recent motion/theme work
3. **If specific bug**: Fix the identified issue with minimal correct edit
4. **If Ford follow-up needed**: Contact Ford for specifics on what needs testing/improvement

---

*Sovereign principle: Ship real artifacts, not guesses. This research doc fulfills that for an ambiguous brief.*
