"""sentry_brief — normalize a raw Sentry webhook payload into a compact brief.

Sentry sends several payload shapes depending on how the alert is wired:

  * Internal-integration "issue alert" webhooks   -> {"action", "data": {"event": {...}, "triggered_rule"}}
  * Resource "issue" / "error" webhooks           -> {"action", "data": {"issue": {...}}}
  * The legacy plugin webhook                      -> a flat event dict

This module is deliberately defensive: real payloads vary by Sentry version and
some fields are optional. We never raise on a missing key — a thin brief is
better than a crash in the relay or the workflow. The output is a small, stable
dict that the Claude Code agent prompt can rely on.
"""

from __future__ import annotations

from typing import Any, Optional

# Keep briefs small — the stacktrace is the signal, everything else is context.
MAX_FRAMES = 25
MAX_VALUE_LEN = 2000


def _first(*candidates: Any) -> Any:
    """Return the first candidate that is not None/empty."""
    for c in candidates:
        if c:
            return c
    return None


def _get(d: Any, *path: str, default: Any = None) -> Any:
    """Safe nested get: _get(payload, 'data', 'event', 'event_id')."""
    cur = d
    for key in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(key)
    return cur if cur is not None else default


def _extract_event(payload: dict) -> dict:
    """Find the event/issue dict inside whatever shape Sentry sent."""
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, dict):
        if isinstance(data.get("event"), dict):
            return data["event"]
        if isinstance(data.get("issue"), dict):
            return data["issue"]
        if isinstance(data.get("error"), dict):
            return data["error"]
    # Legacy / flat payloads: the event *is* the top level.
    if isinstance(payload, dict) and (payload.get("event_id") or payload.get("exception")):
        return payload
    return {}


def _exception_frames(event: dict) -> list[dict]:
    """Flatten the most relevant exception stack frames, innermost last.

    Sentry nests frames under exception.values[].stacktrace.frames[]. We keep the
    last (deepest) frames since those are where the error actually fired, and we
    favour in-app frames so library internals don't crowd out the real culprit.
    """
    exc = event.get("exception")
    values = exc.get("values") if isinstance(exc, dict) else None
    if not isinstance(values, list) or not values:
        return []

    frames: list[dict] = []
    for value in values:
        st = value.get("stacktrace") if isinstance(value, dict) else None
        raw = st.get("frames") if isinstance(st, dict) else None
        if isinstance(raw, list):
            frames.extend(f for f in raw if isinstance(f, dict))

    in_app = [f for f in frames if f.get("in_app")]
    chosen = in_app or frames
    chosen = chosen[-MAX_FRAMES:]

    out = []
    for f in chosen:
        out.append({
            "filename": f.get("filename") or f.get("abs_path"),
            "function": f.get("function"),
            "lineno": f.get("lineno"),
            "in_app": bool(f.get("in_app")),
            "context_line": (f.get("context_line") or "").strip()[:MAX_VALUE_LEN],
        })
    return out


def _culprit_location(frames: list[dict]) -> Optional[str]:
    """Best single 'file:line' the agent should look at first."""
    for f in reversed(frames):
        if f.get("in_app") and f.get("filename") and f.get("lineno"):
            return f"{f['filename']}:{f['lineno']}"
    for f in reversed(frames):
        if f.get("filename") and f.get("lineno"):
            return f"{f['filename']}:{f['lineno']}"
    return None


def build_brief(payload: dict) -> dict:
    """Turn a raw Sentry webhook payload into a compact, agent-ready brief."""
    event = _extract_event(payload)
    metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}

    exc = event.get("exception")
    exc_values = exc.get("values") if isinstance(exc, dict) else None
    exc_type = exc_value = None
    if isinstance(exc_values, list) and exc_values:
        last = exc_values[-1]
        if isinstance(last, dict):
            exc_type = last.get("type")
            exc_value = (last.get("value") or "")[:MAX_VALUE_LEN]

    tags = event.get("tags")
    tag_map: dict[str, str] = {}
    if isinstance(tags, list):
        for t in tags:
            if isinstance(t, (list, tuple)) and len(t) == 2:
                tag_map[str(t[0])] = str(t[1])
            elif isinstance(t, dict) and "key" in t:
                tag_map[str(t["key"])] = str(t.get("value"))
    elif isinstance(tags, dict):
        tag_map = {str(k): str(v) for k, v in tags.items()}

    request = event.get("request") if isinstance(event.get("request"), dict) else {}
    frames = _exception_frames(event)

    return {
        "issue_id": _first(_get(payload, "data", "issue", "id"),
                           event.get("issue_id"), event.get("group_id")),
        "event_id": event.get("event_id") or event.get("id"),
        "title": _first(event.get("title"), metadata.get("type"),
                        exc_type, "Sentry issue"),
        "culprit": event.get("culprit") or event.get("transaction"),
        "level": event.get("level") or "error",
        "platform": event.get("platform"),
        "project": _first(_get(payload, "data", "event", "project"),
                          event.get("project"), payload.get("project")),
        "environment": _first(event.get("environment"), tag_map.get("environment")),
        "exception_type": exc_type or metadata.get("type"),
        "exception_value": exc_value or metadata.get("value"),
        "primary_location": _culprit_location(frames),
        "frames": frames,
        "request_url": request.get("url"),
        "request_method": request.get("method"),
        "tags": tag_map,
        "web_url": _first(event.get("web_url"), event.get("issue_url"),
                          _get(payload, "data", "issue", "web_url"),
                          payload.get("url")),
    }


def brief_to_markdown(brief: dict) -> str:
    """Render a brief as the Markdown block injected into the agent prompt."""
    lines = [
        f"# Sentry issue: {brief.get('title')}",
        "",
        f"- **Exception:** `{brief.get('exception_type')}`",
        f"- **Message:** {brief.get('exception_value')}",
        f"- **Level:** {brief.get('level')}",
        f"- **Environment:** {brief.get('environment')}",
        f"- **Project:** {brief.get('project')}",
        f"- **Culprit:** `{brief.get('culprit')}`",
        f"- **Primary location:** `{brief.get('primary_location')}`",
    ]
    if brief.get("request_method") or brief.get("request_url"):
        lines.append(
            f"- **Request:** {brief.get('request_method') or ''} "
            f"{brief.get('request_url') or ''}".rstrip()
        )
    if brief.get("web_url"):
        lines.append(f"- **Sentry link:** {brief.get('web_url')}")

    frames = brief.get("frames") or []
    if frames:
        lines += ["", "## Stack frames (innermost last)", "", "```"]
        for f in frames:
            loc = f"{f.get('filename')}:{f.get('lineno')}"
            marker = "→" if f.get("in_app") else " "
            lines.append(f"{marker} {loc} in {f.get('function')}")
            if f.get("context_line"):
                lines.append(f"      {f['context_line']}")
        lines.append("```")

    tags = brief.get("tags") or {}
    if tags:
        lines += ["", "## Tags", ""]
        lines += [f"- {k} = {v}" for k, v in sorted(tags.items())]

    return "\n".join(lines)
