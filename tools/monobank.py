#!/usr/bin/env python3
"""Helper for the monobank personal API (jar payments).

    python3 tools/monobank.py jars                       # list your jars with their account ids
    python3 tools/monobank.py webhook <url>              # register the payment webhook
    python3 tools/monobank.py status                     # show the currently registered webhook

The personal token (from https://api.monobank.ua/) is read from the MONO_PERSONAL_TOKEN
environment variable or asked for interactively. It is never saved to disk.
"""
import getpass
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.monobank.ua"


def token():
    t = os.environ.get("MONO_PERSONAL_TOKEN") or getpass.getpass("monobank personal token: ").strip()
    if not t:
        sys.exit("No token.")
    return t


def call(path, tok, body=None):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"X-Token": tok, "Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"monobank error {e.code}: {e.read().decode(errors='replace')}")


def jars(tok):
    info = call("/personal/client-info", tok)
    items = info.get("jars") or []
    if not items:
        print("No jars found. Create one in the monobank app (Банки → Створити банку) and run this again.")
        return
    print("Your jars:\n")
    for j in items:
        print(f"  title:      {j.get('title')}")
        print(f"  account_id: {j.get('id')}      ← put this into catalog.json → site.jar.account_id")
        print(f"  sendId:     {j.get('sendId')}      (the jar link is https://send.monobank.ua/{j.get('sendId')})")
        print(f"  balance:    {j.get('balance', 0) / 100:.2f}\n")


def webhook(tok, url):
    if not url.startswith("https://"):
        sys.exit("The webhook URL must start with https://")
    call("/personal/webhook", tok, {"webHookUrl": url})
    print("Webhook registered. monobank checked the URL and accepted it.")


def status(tok):
    info = call("/personal/client-info", tok)
    print("Webhook:", info.get("webHookUrl") or "(none)")


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("jars", "webhook", "status"):
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == "webhook" and len(sys.argv) != 3:
        sys.exit("Usage: python3 tools/monobank.py webhook https://<site>/api/mono-hook/<secret>")
    tok = token()
    if cmd == "jars":
        jars(tok)
    elif cmd == "webhook":
        webhook(tok, sys.argv[2])
    else:
        status(tok)


if __name__ == "__main__":
    main()
