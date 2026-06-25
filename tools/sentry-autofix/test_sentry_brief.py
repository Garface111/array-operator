"""Tests for sentry_brief — run with: python -m pytest tools/sentry-autofix/

Uses a payload modeled on the real production issue that motivated this system:
IntegrityError / UniqueViolation on uq_daily_array_day in /v1/array-owners/inverter-capture.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from sentry_brief import brief_to_markdown, build_brief  # noqa: E402

ISSUE_ALERT_PAYLOAD = {
    "action": "triggered",
    "data": {
        "event": {
            "event_id": "3fec4eebd2054109b79f5742cf118803",
            "title": "IntegrityError: (psycopg2.errors.UniqueViolation) duplicate key value",
            "culprit": "/v1/array-owners/inverter-capture",
            "level": "error",
            "platform": "python",
            "project": "python-fastapi",
            "environment": "production",
            "exception": {
                "values": [{
                    "type": "IntegrityError",
                    "value": '(psycopg2.errors.UniqueViolation) duplicate key value violates unique constraint "uq_daily_array_day"',
                    "stacktrace": {"frames": [
                        {"filename": "sqlalchemy/engine/base.py", "function": "_exec_single_context",
                         "lineno": 1967, "in_app": False, "context_line": "self.dialect.do_execute(...)"},
                        {"filename": "api/array_owners.py", "function": "inverter_capture",
                         "lineno": 2769, "in_app": True, "context_line": "db.flush()"},
                    ]},
                }],
            },
            "request": {"url": "http://web-production-49c83.up.railway.app/v1/array-owners/inverter-capture",
                        "method": "POST"},
            "tags": [["environment", "production"], ["handled", "yes"], ["client_os", "Windows"]],
            "web_url": "https://sentry.io/organizations/x/issues/123/",
        },
    },
}


def test_extracts_core_fields():
    b = build_brief(ISSUE_ALERT_PAYLOAD)
    assert b["exception_type"] == "IntegrityError"
    assert "uq_daily_array_day" in b["exception_value"]
    assert b["environment"] == "production"
    assert b["project"] == "python-fastapi"
    assert b["request_method"] == "POST"


def test_primary_location_prefers_in_app_frame():
    b = build_brief(ISSUE_ALERT_PAYLOAD)
    # The sqlalchemy frame is deeper but not in-app; the culprit is our code.
    assert b["primary_location"] == "api/array_owners.py:2769"


def test_tags_normalized_to_map():
    b = build_brief(ISSUE_ALERT_PAYLOAD)
    assert b["tags"]["handled"] == "yes"
    assert b["tags"]["environment"] == "production"


def test_handles_resource_issue_shape():
    payload = {"action": "created", "data": {"issue": {
        "id": "555", "title": "KeyError: foo", "level": "error",
        "metadata": {"type": "KeyError", "value": "'foo'"},
        "web_url": "https://sentry.io/i/555/"}}}
    b = build_brief(payload)
    assert b["issue_id"] == "555"
    assert b["exception_type"] == "KeyError"
    assert b["web_url"].endswith("/555/")


def test_never_raises_on_garbage():
    for junk in ({}, {"data": {}}, {"data": {"event": {}}}, {"random": 1}):
        b = build_brief(junk)
        assert isinstance(b, dict)
        assert "title" in b


def test_markdown_renders_location_and_frames():
    md = brief_to_markdown(build_brief(ISSUE_ALERT_PAYLOAD))
    assert "api/array_owners.py:2769" in md
    assert "## Stack frames" in md
    assert "IntegrityError" in md


if __name__ == "__main__":
    # Allow running without pytest installed.
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all tests passed")
