# Serve the repo at http://localhost:8080 for local testing, with caching OFF.
#
#   python scripts/serve-local.py            (or the "speeksnet" entry in .claude/launch.json)
#
# Why not `python -m http.server`: it sends Last-Modified and no Cache-Control,
# so the browser keeps its own copy of operations.html. The cache-buster is IN
# that file, so a page update never reached Ethan's tab. On 2026-10-16 he was
# labelling on a speeks.js two versions old and saw the old counts. Every
# response here says no-store, so a plain refresh always loads what's on disk.
import functools
import http.server
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(NoCache, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", 8080), handler) as httpd:
        print("Serving", ROOT, "at http://localhost:8080 (no caching)")
        httpd.serve_forever()
