#!/usr/bin/env python3
"""本地服务：给浏览器页面提供「语雀访问密码」与「正文落盘」两个端点。

· GET  /pw?slug=<doc_slug>  → 返回该文档的访问密码（从 .env 规则里解析，不打印、不记日志）
· POST /save/<name>          → 把正文写入 /opt/chatwoot-kb/（绕过模型上下文）

仅监听 127.0.0.1。密码只存在于进程内存，日志里绝不出现。
"""
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ENV = "/opt/chatwoot-telegram-bot/.env"
OUT = "/opt/chatwoot-kb"
os.makedirs(OUT, exist_ok=True)


def load_passwords():
    """解析规则里的「国内地址（查看密码 xxx）」+ 紧随其后的语雀链接，得到 slug → 密码。"""
    text = open(ENV, encoding="utf-8").read()
    out = {}
    for m in re.finditer(r"查看密码\s*([A-Za-z0-9]{3,12})", text):
        tail = text[m.end(): m.end() + 400]
        u = re.search(r"yuque\.com/[\w\-]+/[\w\-]+/([A-Za-z0-9]{6,})", tail)
        if u:
            out[u.group(1)] = m.group(1)
    return out


PASSWORDS = load_passwords()


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        if self.path.startswith("/pw"):
            slug = self.path.split("slug=")[-1].strip()
            pw = PASSWORDS.get(slug, "")
            body = pw.encode()
            print(f"[sink] /pw slug={slug} 命中={bool(pw)}", flush=True)   # 不打印密码
        elif self.path.startswith("/list"):
            body = ",".join(PASSWORDS.keys()).encode()
        else:
            body = b"ok"
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n)
        name = self.path.strip("/").replace("/", "_") or "chunk"
        with open(os.path.join(OUT, name + ".txt"), "wb") as f:
            f.write(data)
        print(f"[sink] {self.path} <- {n} 字节", flush=True)
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"saved")

    def log_message(self, *args):
        pass


print(f"[sink] 127.0.0.1:8899 就绪；已解析 {len(PASSWORDS)} 个语雀密码", flush=True)
ThreadingHTTPServer(("127.0.0.1", 8899), Handler).serve_forever()
