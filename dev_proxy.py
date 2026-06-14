"""
Local dev server for the Array Operator static site.

In production Netlify serves public/ and proxies /v1/*, /accounts, /onboarding to
the Railway backend (see public/_redirects). A plain `python -m http.server`
can't proxy, so uploads to /v1/array-operator/billing/* fail locally with a
network error. This script reproduces the Netlify behavior for local review:

  * serve files from ./public for normal paths
  * reverse-proxy /v1, /accounts, /onboarding, /health, /docs to BACKEND
    (default http://127.0.0.1:8788 — the solar-operator-api launch config).

Run:  BACKEND=http://127.0.0.1:8788 python3 dev_proxy.py 8089
Dev-only; not part of the deployed site.
"""
import os
import sys
import http.server
import socketserver
import urllib.request
import urllib.error
from functools import partial

BACKEND = os.environ.get("BACKEND", "http://127.0.0.1:8788").rstrip("/")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8089
PUBLIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
PROXY_PREFIXES = ("/v1", "/accounts", "/onboarding", "/health", "/docs", "/openapi.json")


class Handler(http.server.SimpleHTTPRequestHandler):
    def _is_proxied(self):
        return any(self.path == p or self.path.startswith(p + "/") or
                   self.path.startswith(p + "?") for p in PROXY_PREFIXES)

    def _proxy(self):
        url = BACKEND + self.path
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(url=url, data=body, method=self.command)
        for k, v in self.headers.items():
            if k.lower() in ("host", "content-length", "connection",
                             "accept-encoding"):
                continue
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() in ("transfer-encoding", "connection",
                                     "content-encoding"):
                        continue
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            for k, v in e.headers.items():
                if k.lower() in ("transfer-encoding", "connection",
                                 "content-encoding"):
                    continue
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # backend down, etc.
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(f'{{"ok":false,"detail":"dev proxy: backend unreachable ({e})"}}'.encode())

    def do_GET(self):
        if self._is_proxied():
            return self._proxy()
        return super().do_GET()

    def do_POST(self):
        if self._is_proxied():
            return self._proxy()
        self.send_error(501, "Unsupported method ('POST')")

    def do_PATCH(self):
        if self._is_proxied():
            return self._proxy()
        self.send_error(501, "Unsupported method ('PATCH')")

    def do_DELETE(self):
        if self._is_proxied():
            return self._proxy()
        self.send_error(501, "Unsupported method ('DELETE')")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT),
                                         partial(Handler, directory=PUBLIC)) as httpd:
        print(f"Array Operator dev proxy: http://0.0.0.0:{PORT}  →  {BACKEND} for /v1")
        httpd.serve_forever()
