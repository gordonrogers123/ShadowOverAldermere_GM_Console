#!/usr/bin/env python3
"""serve.py -- the local helper server for the GM Console.

Serves the static files (so the GM and Player windows share one origin and
BroadcastChannel sync works) AND handles POST /rescan, which rescans the asset
folders, regenerates data/manifest.js, and returns the fresh lists as JSON.
That is what the "Rescan assets" button in the GM window calls, so dropping a
file into assets/ and clicking the button refreshes the builder's pick lists.

It also handles POST /save-scenes, which writes the GM's saved scenes to
data/userScenes.json (atomically) so day-before setups survive between sessions;
the app loads that file at startup. Both endpoints degrade gracefully when the
server is absent (the static deploy keeps using localStorage / the committed
manifest).

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
        if self.path.rstrip("/") == "/save-scenes":
            try:
                length = int(self.headers.get("Content-Length", 0))
                scenes = json.loads(self.rfile.read(length).decode("utf-8")) if length else []
                # The GM is the only writer; still, refuse anything that is not a
                # list of scene objects with a string id, so a bad request can't
                # corrupt the saved-scene file.
                if not isinstance(scenes, list) or not all(
                    isinstance(s, dict) and isinstance(s.get("id"), str) and s["id"]
                    for s in scenes
                ):
                    self._json(400, {"ok": False, "error": "expected a JSON array of scenes, each with a string id"})
                    return
                out = os.path.join(ROOT, "data", "userScenes.json")
                tmp = out + ".tmp"
                with open(tmp, "w", encoding="utf-8") as handle:
                    json.dump(scenes, handle, indent=2)
                os.replace(tmp, out)  # atomic swap, so a concurrent read never tears
                self._json(200, {"ok": True, "count": len(scenes)})
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
