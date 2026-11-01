# Serve the repo at http://localhost:8080 for local testing, with caching OFF.
#
#   python scripts/serve-local.py            (or the "speeksnet" entry in .claude/launch.json)
#   python scripts/serve-local.py 8081       (a second checkout, e.g. a git worktree)
#
# The port is an argument because two worktrees run side by side (2026-10-21:
# Picture Quality on Update 2, QuickPortal on Update 3). Each serves ITS OWN
# folder — ROOT is this file's checkout — so they need different ports, not one
# server for both.
#
# Why not `python -m http.server`: it sends Last-Modified and no Cache-Control,
# so the browser keeps its own copy of operations.html. The cache-buster is IN
# that file, so a page update never reached Ethan's tab. On 2026-10-16 he was
# labelling on a speeks.js two versions old and saw the old counts. Every
# response here says no-store, so a plain refresh always loads what's on disk.
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = functools.partial(NoCache, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print("Serving", ROOT, "at http://localhost:%d (no caching)" % port)
        httpd.serve_forever()
