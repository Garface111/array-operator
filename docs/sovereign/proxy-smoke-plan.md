# Proxy-Smoke Implementation Plan

**Feature #39 · Owner Improve Brief**

## Analysis

The brief "proxy-smoke" is ambiguous without additional context. Common interpretations in web infrastructure:

1. **Smoke testing through a proxy** - Health checks/validation that traffic flows correctly through reverse proxies
2. **Proxy configuration visibility** - UI showing proxy/CDN status (Netlify edge, Railway direct endpoints)
3. **Service mesh smoke tests** - Quick validation that microservice communication works

## Current Proxy Architecture (from codebase)

From `sovereign-desk.js`:
```javascript
// Chat + turn status go direct to Railway so Netlify's ~60s edge proxy cannot
// 504 a slow brain. History/access stay same-origin (fast).
var RAIL_API = "https://web-production-49c83.up.railway.app";
```

The app already has:
- **Dual-path routing**: Fast queries via Netlify edge (same-origin)
- **Railway direct**: Long-running chat/turn requests bypass Netlify's 60s timeout
- **Smart routing**: Prevents 504 errors on slow AI responses

## Proposed Safe Implementation

### Option A: Proxy Health Indicator (UI)

Add a subtle status indicator showing which path is active:

**Location**: Sovereign Desk footer or header  
**Visual**: Small pill badge showing "Edge" vs "Direct" routing  
**Value**: Transparency for Ford when debugging slow responses

### Option B: Smoke Test Endpoint

Add a lightweight health check that validates both paths:

```javascript
// New endpoint: /v1/sovereign/desk/proxy-health
// Returns: {edge: true, railway: true, latency: {edge: 45ms, rail: 120ms}}
```

**Safety**: Read-only, no state changes, reveals no secrets

### Option C: Enhanced Error Messages

When proxy timeouts occur, show which layer failed:

```
Before: "Request failed"
After:  "Railway timeout (90s) - try shorter prompt"
```

## Recommendation

**Without more context, implementing Option C (better proxy error messages)** is the safest path:
- Requires minimal code (error handling only)
- No new endpoints or UI complexity
- Immediate user value (clearer failure modes)
- Aligns with Ford's "operational clarity" design principle

## Next Steps

1. **Clarify intent**: Does "proxy-smoke" mean:
   - Health checks?
   - Status visibility?
   - Error improvements?
   - Something else?

2. **If health checks**: Implement Option B (new endpoint)
3. **If visibility**: Implement Option A (status badge)
4. **If error clarity**: Implement Option C (enhanced messages)

## Safe No-Op Ship

This doc itself serves as the artifact for feature #39, documenting the proxy architecture and proposing three safe implementation paths. Awaiting owner clarification before coding changes to production routing logic.

---

**Status**: Research complete, awaiting directive  
**Risk**: Low (no code changes yet)  
**Blocking question**: What does "proxy-smoke" mean in Array Operator context?
