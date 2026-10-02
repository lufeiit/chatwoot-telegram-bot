#!/usr/bin/env python3
"""把 v2_knowledge 的 HTML 教程切成可检索段落（v2：修 \r 幽灵行 + 更合理的切段粒度）。

关键修复：以 newline='' 读取，避免 Python universal-newline 把正文里的裸 \r 当成换行。
切段策略：标题为界 + 按目标长度合并相邻段落，避免出现大量 40 字的碎块。
"""
import html
import json
import os
import re
import sys
from collections import Counter
from html.parser import HTMLParser

SRC = os.environ.get("SRC", "/opt/chatwoot-kb/knowledge_raw.tsv")
OUT = os.environ.get("OUT", "/opt/chatwoot-kb/passages.jsonl")
LANGS = {"zh-CN"}
MIN_CHARS = 40
TARGET = 420
MAX_CHARS = 900
BLOCK = {"p", "div", "br", "li", "tr", "td", "h1", "h2", "h3", "h4", "h5", "h6",
         "section", "article", "table", "ul", "ol", "pre", "blockquote"}


class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        elif tag in ("video", "img", "iframe", "source"):
            self.parts.append("\n")
        elif re.fullmatch(r"h[1-6]", tag or ""):
            self.parts.append(f"\n\n[[H{tag[1]}]]")
        elif tag in BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        elif tag in BLOCK or re.fullmatch(r"h[1-6]", tag or ""):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip and data.strip():
            self.parts.append(data)

    def text(self):
        t = html.unescape("".join(self.parts))
        t = t.replace("\r", "\n")
        t = re.sub(r"[ \t\u00a0]+", " ", t)
        t = re.sub(r"\n\s*\n+", "\n", t)
        return t.strip()


def unescape_tsv(s):
    out, i = [], 0
    while i < len(s):
        if s[i] == "\\" and i + 1 < len(s):
            nxt = s[i + 1]
            if nxt in "ntr":
                out.append({"n": "\n", "t": "\t", "r": "\r"}[nxt])
                i += 2
                continue
            if nxt == "\\":
                out.append("\\")
                i += 2
                continue
        out.append(s[i])
        i += 1
    return "".join(out)


def detect_brand(*texts):
    blob = " ".join(texts).lower()
    if "straycloud" in blob or "迷途" in blob:
        return "straycloud"
    if "路飞" in blob or "lufei" in blob:
        return "lufei"
    return "general"


def hard_split(text, limit=MAX_CHARS):
    """超长块按句子边界再切。"""
    pieces, cur = [], ""
    for seg in re.split(r"(?<=[。！？!?；;])", text):
        if len(cur) + len(seg) > limit and cur:
            pieces.append(cur)
            cur = ""
        cur += seg
    if cur:
        pieces.append(cur)
    return pieces


def build_passages(text):
    """返回 [(heading, chunk)]，按标题分界并把相邻短段合并到 TARGET 左右。"""
    sections, heading, buf = [], "", []

    def flush():
        nonlocal buf
        body = "\n".join(x for x in buf if x.strip()).strip()
        if body:
            sections.append((heading, body))
        buf = []

    for raw in text.split("\n"):
        line = raw.strip()
        m = re.fullmatch(r"\[\[H(\d)\]\]", line)
        if m:
            flush()
            heading = line.replace("[[H", "H").replace("]]", "")
            continue
        if not line:
            continue
        # 累积到 TARGET 左右就切开
        if buf and sum(len(x) for x in buf) + len(line) > TARGET:
            flush()
        buf.append(line)
    flush()

    out = []
    for head, body in sections:
        for piece in (hard_split(body) if len(body) > MAX_CHARS else [body]):
            piece = piece.strip()
            if len(piece) >= MIN_CHARS:
                out.append((head, piece))
    return out


def main():
    raw = open(SRC, encoding="utf-8", newline="").read().split("\n")
    rows, bad = [], 0
    for line in raw:
        if not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) != 5:
            bad += 1
            continue
        rows.append([unescape_tsv(c) for c in cols])
    print(f"[解析] 文档 {len(rows)} 条，异常行 {bad} 条")

    passages = []
    for did, lang, category, title, body in rows:
        if lang not in LANGS:
            continue
        ex = TextExtractor()
        ex.feed(body)
        text = ex.text()
        brand = detect_brand(category, title, text)
        for heading, chunk in build_passages(text):
            passages.append({
                "id": f"k{did}-{len(passages)}",
                "source": f"knowledge#{did}",
                "category": category,
                "title": title,
                "heading": heading,
                "brand": brand,
                "text": chunk,
            })

    with open(OUT, "w", encoding="utf-8") as f:
        for p in passages:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")

    lens = sorted(len(p["text"]) for p in passages)
    print(f"[输出] 段落 {len(passages)} 个，共 {sum(lens)} 字")
    print(f"[长度] 中位数={lens[len(lens)//2]}  P10={lens[len(lens)//10]}  "
          f"P90={lens[int(len(lens)*0.9)]}  max={lens[-1]}")
    print(f"[品牌] {dict(Counter(p['brand'] for p in passages))}")
    print(f"[分类] {dict(Counter(p['category'] for p in passages))}")
    print(f"[已写] {OUT}")


if __name__ == "__main__":
    sys.exit(main())
