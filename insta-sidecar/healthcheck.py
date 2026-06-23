"""Container healthcheck: exit 0 only when the bridge is actually logged in to Instagram.

The /health endpoint returns HTTP 200 only once logged in (503 while starting / on a challenge /
on a login failure), so `docker ps` shows whether the auto-login succeeded.
"""
import os
import sys
import urllib.request

port = os.environ.get("IG_SIDECAR_PORT", "8099")
try:
    resp = urllib.request.urlopen(f"http://localhost:{port}/health", timeout=4)
    sys.exit(0 if resp.status == 200 else 1)
except Exception:
    sys.exit(1)
