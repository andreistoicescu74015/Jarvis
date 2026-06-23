#!/usr/bin/env python3
"""
igctl - a tiny CLI to drive a RUNNING insta-sidecar for Phase 1 testing, so you don't have to fight
PowerShell quoting/headers. It sends the correct `Authorization: Bearer <token>` for you.

Run it in a shell where INSTAGRAM_SIDECAR_TOKEN is set to the SAME value app.py uses:

  python igctl.py status                       # is it logged in?
  python igctl.py list                         # recent threads (groups + DMs) WITH their thread_id
  python igctl.py read <username> [count]      # last messages of a 1:1 (by username)
  python igctl.py read <thread_id> [count]     # last messages of a thread/group (long numeric id)
  python igctl.py send <username> <message>    # send a test DM (1:1, by username)
  python igctl.py sendto <thread_id> <message> # send to a thread by id (a GROUP, or a 1:1)
  python igctl.py code <value>                 # answer a login challenge

Env: INSTAGRAM_SIDECAR_TOKEN (required), IG_SIDECAR_URL (default http://localhost:8099).
"""
import os
import sys
import json
import urllib.request
import urllib.error

TOKEN = os.environ.get("INSTAGRAM_SIDECAR_TOKEN", "")
URL = os.environ.get("IG_SIDECAR_URL", "http://localhost:8099").rstrip("/")


def call(path, body):
    req = urllib.request.Request(
        URL + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            print(resp.read().decode())
    except urllib.error.HTTPError as err:
        print(f"HTTP {err.code}: {err.read().decode()}")
    except Exception as err:  # noqa: BLE001
        print(f"could not reach the sidecar at {URL} ({err}) - is app.py running?")


def main():
    if not TOKEN:
        print("Set INSTAGRAM_SIDECAR_TOKEN in this shell first (the same value app.py uses).")
        return
    args = sys.argv[1:]
    cmd = args[0] if args else "status"
    if cmd == "status":
        call("/status", {})
    elif cmd == "list":
        call("/threads", {})
    elif cmd == "send" and len(args) >= 3:
        call("/send", {"username": args[1], "text": " ".join(args[2:])})
    elif cmd == "sendto" and len(args) >= 3:
        call("/send", {"thread_id": args[1], "text": " ".join(args[2:])})
    elif cmd == "read" and len(args) >= 2:
        amount = int(args[2]) if len(args) >= 3 and args[2].isdigit() else 10
        # a long all-digit value is a thread_id (group/1:1); otherwise it's a username
        if args[1].isdigit() and len(args[1]) > 6:
            call("/messages", {"thread_id": args[1], "amount": amount})
        else:
            call("/messages", {"username": args[1], "amount": amount})
    elif cmd == "code" and len(args) >= 2:
        call("/challenge", {"code": args[1]})
    else:
        print("usage: python igctl.py status | list | read <user|thread_id> [count] | send <username> <message> | sendto <thread_id> <message> | code <value>")


if __name__ == "__main__":
    main()
