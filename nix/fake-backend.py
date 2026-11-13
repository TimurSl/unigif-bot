"""Stands in for both Telegram's Bot API (port 8081) and a Unigif server (port 8787) in the NixOS VM test.

Telegram: getMe, deleteWebhook and setMyCommands succeed; getUpdates delivers one inline query and one chat
message, once; every call the bot makes is appended to /tmp/telegram-calls.log and answerInlineQuery's body
is kept in /tmp/answer.json. Unigif: /me, /gifs, /gifs/<id>/use and the MP4 bytes.
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

USER = {"id": 1, "is_bot": False, "first_name": "Tester"}
UPDATES = [
    {
        "update_id": 10,
        "inline_query": {"id": "iq1", "from": USER, "query": "cat ", "offset": "", "chat_type": "sender"},
    },
    {
        "update_id": 11,
        "message": {
            "message_id": 1,
            "date": 0,
            "chat": {"id": 1, "type": "private", "first_name": "Tester"},
            "from": USER,
            "text": "cat funny",
        },
    },
]
GIF_ID = "aaaaaaaaaaaa"
LOCK = threading.Lock()


def media(name, size):
    return {"url": f"http://unigif.example/m/{GIF_ID}/{name}", "width": 480, "height": 270, "bytes": size}


GIF = {
    "id": GIF_ID,
    "status": "ready",
    "tags": ["cat", "funny"],
    "description": None,
    "width": 480,
    "height": 270,
    "duration_ms": 2400,
    "page_url": f"http://unigif.example/g/{GIF_ID}",
    "media": {"mp4": media("full.mp4", 2000), "preview_mp4": media("preview.mp4", 900), "poster": None},
}


class Quiet(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, body, status=200):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""


class Telegram(Quiet):
    def do_POST(self):
        method = self.path.rsplit("/", 1)[-1]
        raw = self.body()
        with LOCK:
            with open("/tmp/telegram-calls.log", "a") as log:
                log.write(method + "\n")
            if method == "answerInlineQuery":
                with open("/tmp/answer.json", "wb") as f:
                    f.write(raw)
        if method == "getMe":
            self.send_json({"ok": True, "result": {
                "id": 123456, "is_bot": True, "first_name": "Unigif", "username": "unigif_test_bot",
                "can_join_groups": True, "can_read_all_group_messages": False,
                "supports_inline_queries": True, "can_connect_to_business": False, "has_main_web_app": False,
            }})
        elif method == "getUpdates":
            offset = json.loads(raw or b"{}").get("offset", 0)
            fresh = [u for u in UPDATES if u["update_id"] >= offset]
            if not fresh:
                time.sleep(1)
            self.send_json({"ok": True, "result": fresh})
        elif method == "sendAnimation":
            self.send_json({"ok": True, "result": {
                "message_id": 2, "date": 0, "chat": {"id": 1, "type": "private"},
                "animation": {"file_id": "VMFILE1", "file_unique_id": "u1", "width": 480, "height": 270, "duration": 2},
            }})
        else:
            self.send_json({"ok": True, "result": True})


class Unigif(Quiet):
    def authorized(self):
        if self.headers.get("Authorization") == "Bearer ugf_vmtest_secret":
            return True
        self.send_json({"type": "about:blank", "title": "x", "status": 401,
                        "detail": "missing or invalid credentials", "code": "unauthorized"}, 401)
        return False

    def do_GET(self):
        if self.path.startswith("/m/"):
            with open("/tmp/unigif-downloads.log", "a") as log:
                log.write(self.path + "\n")
            raw = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 2000
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        elif not self.authorized():
            return
        elif self.path.startswith("/api/v1/me"):
            self.send_json({"kind": "key", "name": "telegram", "scopes": ["read"], "deny_tags": [], "limits": None})
        elif self.path.startswith("/api/v1/gifs"):
            self.send_json({"items": [GIF], "next_cursor": None})
        else:
            self.send_json({"detail": "not found", "code": "not_found"}, 404)

    def do_POST(self):
        if not self.authorized():
            return
        with open("/tmp/unigif-uses.log", "a") as log:
            log.write(self.path + "\n")
        self.send_response(204)
        self.end_headers()


if __name__ == "__main__":
    servers = [
        ThreadingHTTPServer(("127.0.0.1", 8081), Telegram),
        ThreadingHTTPServer(("127.0.0.1", 8787), Unigif),
    ]
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    servers[0].serve_forever()
