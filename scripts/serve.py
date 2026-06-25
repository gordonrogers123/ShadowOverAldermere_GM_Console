#!/usr/bin/env python3
"""serve.py -- the local helper server for the GM Console.

Serves the static files (so the GM and Player windows share one origin and
BroadcastChannel sync works) AND handles POST /rescan, which rescans the asset
folders, regenerates data/manifest.js, and returns the fresh lists as JSON.
That is what the "Rescan assets" button in the GM window calls, so dropping a
file into assets/ and clicking the button refreshes the builder's pick lists.

Offline, standard library only. On the static deploy there is no server, so the
button is simply absent and the committed manifest is used as-is.

Usage:
    python3 scripts/serve.py [port]      # default port 8000
"""
from __future__ import annotations

import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import scan_assets  # noqa: E402  (local module, after sys.path tweak)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # Serve files from the project root regardless of the launch cwd.
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self):
        if self.path.rstrip("/") == "/rescan":
            try:
                data = scan_assets.write_manifest()
                self._json(200, {"ok": True, **data})
            except Exception as err:  # noqa: BLE001 -- report any failure to the UI
                self._json(500, {"ok": False, "error": str(err)})
            return
        self.send_error(404, "Not Found")

    def _json(self, code, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def end_headers(self):
        # No caching, so a regenerated manifest or an edited file loads fresh.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quieter than the default; keep errors only.
        if str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    base = f"http://127.0.0.1:{port}"
    print(f"Aldermere GM Console serving at {base}/")
    print(f"  GM:     {base}/?view=gm")
    print(f"  Player: {base}/?view=player")
    print("POST /rescan regenerates data/manifest.js. Press Ctrl-C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
