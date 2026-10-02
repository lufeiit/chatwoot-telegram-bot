#!/usr/bin/env python3
"""合并三来源知识库：v2board 教程 + EZ-THEME-R 前端提示/服务条款（语雀待补）。

改进点：主题文案标题带章节路径（如 EZ-THEME-R/order/paragraph4），便于客服看清出处。
产出 /opt/chatwoot-kb/passages_all.jsonl
"""
import json
import os
import re
from collections import Counter

KB_DIR = "/opt/chatwoot-kb"
I18N = "/opt/EZ-THEME-R/src/i18n/locales/zh-CN.js"
MIN_CHARS = 14
SIGNAL = ("不", "请", "需", "若", "如", "无法", "禁止", "支持", "注意", "须知", "退款",
          "到期", "流量", "订阅", "节点", "密码", "套餐", "余额", "抵扣", "重置", "设备",
          "限", "规则", "服务", "订单")


def extract_theme():
    """按缩进跟踪 section/key，保留章节归属。"""
    lines = open(I18N, encoding="utf-8").read().split("\n")
    section, out, seen = "", [], set()
    re_sec = re.compile(r"^\s{4}([A-Za-z_]\w*)\s*:\s*\{\s*$")
    re_kv = re.compile(r"^\s+([A-Za-z_]\w*)\s*:\s*(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\")\s*,?\s*$")
    re_obj = re.compile(r"^\s{8}([A-Za-z_]\w*)\s*:\s*\{\s*$")   # 二级子对象

    for line in lines:
        m = re_sec.match(line)
        if m:
            section = m.group(1)
            continue
        m2 = re_obj.match(line)
        if m2:
            section = f"{section}.{m2.group(1)}" if section else m2.group(1)
            continue
        kv = re_kv.match(line)
        if not kv:
            continue
        key = kv.group(1)
        val = (kv.group(2) if kv.group(2) is not None else kv.group(3) or "")
        val = val.replace("\\'", "'").replace('\\"', '"').replace("\\n", " ").strip()
        plain = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", val)).strip()
        if len(plain) < MIN_CHARS or not any(s in plain for s in SIGNAL):
            continue
        if plain.count("{") and len(plain) < 45:      # 纯插值模板多为 UI 标签
            continue
        if plain in seen:
            continue
        seen.add(plain)
        out.append({"category": "前端提示" if section not in ("shop", "order", "ticket", "serviceTerms") else "服务条款",
                    "title": f"EZ-THEME-R/{section}/{key}",
                    "heading": "", "brand": "general", "source": "theme", "text": plain})
    return out


v2 = [json.loads(l) for l in open(f"{KB_DIR}/passages.jsonl", encoding="utf-8")]
for p in v2:
    p.setdefault("source", "v2board")
theme = extract_theme()

# ── 主题隔离：AppleID/共享ID 类内容只在问到相关话题时才可检索 ──
APPLEID_HINTS = ("共享ID", "共享 ID", "AppleID", "Apple ID", "苹果ID", "美区", "自购ID",
                 "小火箭", "Shadowrocket", "shadowrocket", "Stash", "AppStore")


def topic_of(p):
    blob = p["title"] + " " + p["text"]
    if any(k in blob for k in APPLEID_HINTS):
        return "appleid"
    return ""


for p in v2 + theme:
    p["topic"] = topic_of(p)

allp = []
for i, p in enumerate(v2 + theme):
    p = dict(p)
    p["id"] = f"kb{i}"
    allp.append(p)

with open(f"{KB_DIR}/passages_all.jsonl", "w", encoding="utf-8") as f:
    for p in allp:
        f.write(json.dumps(p, ensure_ascii=False) + "\n")

print(f"[合并] v2board {len(v2)} + theme {len(theme)} = {len(allp)} 段，"
      f"共 {sum(len(p['text']) for p in allp)} 字")
from collections import Counter as _C
print(f"[主题隔离] {dict(_C(p.get('topic','') for p in allp))}")
print(f"[来源分布] {dict(Counter(p['source'] for p in allp))}")
print(f"[分类分布] {dict(Counter(p['category'] for p in allp))}")
refund = [p for p in allp if "退款" in p["text"]]
print(f"\n[含「退款」的段落 {len(refund)} 个]")
for p in refund:
    print(f"  · [{p['category']}/{p['title'][:46]}] {p['text'][:120]}")
