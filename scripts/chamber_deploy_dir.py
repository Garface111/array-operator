#!/usr/bin/env python3
"""Deploy a directory to the Sovereign CHAMBER (false-real AO) via Netlify REST.

Creates a **branch deploy** on the existing production site
(array-operator-ea / 966cb1f5-…) with branch name ``chamber``.

Stable URL:
  https://chamber--array-operator-ea.netlify.app

This does **NOT** publish production (arrayoperator.com). Context is
``deploy-preview`` / branch deploy. Safe after the 2026-07-20 gate incident:
files-only REST upload, no netlify.toml, no edge functions.

Usage:
  python3 scripts/chamber_deploy_dir.py [dir]
  # default dir: ./public (or git-archive export)

Env:
  NETLIFY_AUTH_TOKEN or ~/.hermes/secrets/netlify_token
  NETLIFY_CHAMBER_SITE_ID   (default: prod AO site — branch only)
  NETLIFY_CHAMBER_BRANCH    (default: chamber)
  CHAMBER_URL_OUT           optional path to write URL JSON

Exit 0 prints deploy_ssl_url on success.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

# Same site as prod — chamber is a branch deploy, never the production context.
PROD_SITE = "966cb1f5-944e-41fd-855b-10053edc5d18"
SITE = os.getenv("NETLIFY_CHAMBER_SITE_ID", PROD_SITE)
BRANCH = (os.getenv("NETLIFY_CHAMBER_BRANCH") or "chamber").strip() or "chamber"
API = "https://api.netlify.com/api/v1"
ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public"
)


def _token() -> str:
    t = (os.getenv("NETLIFY_AUTH_TOKEN") or os.getenv("NETLIFY_TOKEN") or "").strip()
    if t:
        return t
    p = os.path.expanduser("~/.hermes/secrets/netlify_token")
    if os.path.isfile(p):
        return open(p, encoding="utf-8").read().strip()
    raise SystemExit("FATAL: no Netlify token (NETLIFY_AUTH_TOKEN or ~/.hermes/secrets/netlify_token)")


def walk_files(root: str) -> dict[str, tuple[str, bytes]]:
    out: dict[str, tuple[str, bytes]] = {}
    for dirpath, _dirs, names in os.walk(root):
        for n in names:
            full = os.path.join(dirpath, n)
            rel = "/" + os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as f:
                data = f.read()
            out[rel] = (hashlib.sha1(data).hexdigest(), data)
    return out


def req(method: str, url: str, body=None, headers=None, raw=False, token: str = ""):
    hdrs = {
        "Authorization": "Bearer " + token,
        "User-Agent": "ao-chamber-deploy/1.0",
    }
    if headers:
        hdrs.update(headers)
    data = body if raw else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main() -> None:
    root = os.path.abspath(ROOT)
    print("CHAMBER deploy (branch, never production)")
    print("ROOT:", root)
    print("SITE:", SITE)
    print("BRANCH:", BRANCH)

    if not os.path.isdir(root):
        print("FATAL: not a directory:", root)
        sys.exit(1)
    if os.path.isfile(os.path.join(root, "netlify.toml")):
        print("FATAL: netlify.toml inside deploy dir — refuse (edge gate risk)")
        sys.exit(1)
    if os.path.isdir(os.path.join(root, "netlify")) or os.path.isdir(
        os.path.join(root, "edge-functions")
    ):
        print("FATAL: edge-functions/netlify dir inside deploy root — refuse")
        sys.exit(1)

    token = _token()
    files = walk_files(root)
    banned = [
        p
        for p in files
        if "edge-functions" in p or p.endswith("/gate.ts") or p.endswith("netlify.toml")
    ]
    if banned:
        print("FATAL: banned paths:", banned[:5])
        sys.exit(1)
    if not files:
        print("FATAL: no files to deploy")
        sys.exit(1)

    digest_map = {p: sha for p, (sha, _d) in files.items()}
    # draft + branch → deploy-preview context; deploy_ssl_url is the chamber URL.
    # NEVER omit branch/draft in a way that could publish production.
    payload = {
        "files": digest_map,
        "draft": True,
        "branch": BRANCH,
        "title": f"sovereign-chamber {BRANCH}",
    }
    print(f"creating branch deploy · {len(files)} files…")
    st, body = req(
        "POST",
        f"{API}/sites/{SITE}/deploys",
        payload,
        {"Content-Type": "application/json"},
        token=token,
    )
    if st not in (200, 201):
        print("create deploy FAILED", st, body[:400])
        sys.exit(1)
    dep = json.loads(body)
    dep_id = dep["id"]
    context = dep.get("context")
    if context == "production":
        print("FATAL: deploy context is production — aborting before upload")
        print("       Chamber must never publish arrayoperator.com")
        sys.exit(1)
    required = set(dep.get("required") or [])
    chamber_url = (
        dep.get("deploy_ssl_url")
        or dep.get("deploy_url")
        or f"https://{BRANCH}--array-operator-ea.netlify.app"
    )
    print(f"deploy {dep_id} · context={context} · branch={dep.get('branch')}")
    print(f"chamber_url (pre-ready): {chamber_url}")
    print(f"{len(required)} files to upload")

    uploaded = 0
    for path, (sha, data) in files.items():
        if sha not in required:
            continue
        st, b = req(
            "PUT",
            f"{API}/deploys/{dep_id}/files{path}",
            body=data,
            headers={"Content-Type": "application/octet-stream"},
            raw=True,
            token=token,
        )
        if st not in (200, 201):
            print("upload FAILED", path, st, b[:200])
            sys.exit(1)
        uploaded += 1
    print(f"uploaded {uploaded} files")

    final = dep
    for _ in range(60):
        st, b = req("GET", f"{API}/deploys/{dep_id}", token=token)
        final = json.loads(b)
        state = final.get("state")
        if state == "ready":
            print("STATE: ready ✓")
            break
        if state == "error":
            print("STATE: error", b[:300])
            sys.exit(1)
        time.sleep(2)
    else:
        print("WARNING: deploy not ready after wait; state=", final.get("state"))

    if final.get("context") == "production":
        print("FATAL: finished deploy reports context=production")
        sys.exit(1)
    if final.get("edge_functions_present") is True:
        print("FATAL: edge_functions_present on chamber deploy — refuse")
        sys.exit(1)

    chamber_url = (
        final.get("deploy_ssl_url")
        or final.get("deploy_url")
        or chamber_url
    ).replace("http://", "https://")
    # Sanity: production primary URL must not be our only link
    prod_ssl = final.get("ssl_url") or ""
    if chamber_url.rstrip("/") in (
        "https://arrayoperator.com",
        "http://arrayoperator.com",
        prod_ssl.rstrip("/"),
    ):
        # Prefer explicit branch subdomain
        chamber_url = f"https://{BRANCH}--array-operator-ea.netlify.app"

    out = {
        "ok": True,
        "deploy_id": dep_id,
        "context": final.get("context"),
        "branch": final.get("branch") or BRANCH,
        "state": final.get("state"),
        "chamber_url": chamber_url.rstrip("/"),
        "files": len(files),
        "site_id": SITE,
        "note": "branch/draft deploy — production arrayoperator.com untouched",
    }
    print("chamber_url:", out["chamber_url"])
    print(json.dumps(out, indent=2))

    out_path = os.getenv("CHAMBER_URL_OUT")
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2)
            f.write("\n")

    # Optional smoke: chamber must not be empty and prod must still be 200
    try:
        code, body = req("GET", out["chamber_url"] + "/", token="")
        # unauth GET without token header for public URL
    except Exception:
        pass
    try:
        r = urllib.request.Request(out["chamber_url"] + "/", method="GET")
        with urllib.request.urlopen(r, timeout=30) as resp:
            print("chamber HTTP", resp.status, "len", len(resp.read()))
    except Exception as e:
        print("chamber smoke warn:", e)
    try:
        with urllib.request.urlopen("https://arrayoperator.com/", timeout=20) as resp:
            print("prod still HTTP", resp.status)
    except Exception as e:
        print("prod smoke warn:", e)


if __name__ == "__main__":
    main()
