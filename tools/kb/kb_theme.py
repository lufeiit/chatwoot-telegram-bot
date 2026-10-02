#!/usr/bin/env python3
"""从 EZ-THEME-R 前端抽取用户可见语义（i18n 文案 + 服务条款），产出知识库段落。

来源标记 source=theme，品牌 general（主题两站共用）。
只抽取「有语义的句子」，过滤纯 UI 标签（登录/取消/提交 之类）。
"""
import json
import os
import re
import sys
from collections import defaultdict

SRC = os.environ.get("TZ_I18N", "/opt/EZ-THEME-R/src/i18n/locales/zh-CN.js")
OUT = os.environ.get("OUT", "/opt/chatwoot-kb/theme_passages.jsonl")
MIN_CHARS = 14
# 有语义价值的信号词（含其一才收）
SIGNAL = ("不", "请", "需", "若", "如", "无法", "禁止", "支持", "注意", "须知", "退款",
          "到期", "流量", "订阅", "节点", "密码", "套餐", "余额", "抵扣", "重置", "设备",
          "限", "规则", "服务", "订单")

text = open(SRC, encoding="utf-8").read()

# 抽取 'key': 'value' / key: 'value' / "value"（忽略模板字符串）
PATTERN = re.compile(r"""['"]?([A-Za-z_][\w]*)['"]?\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")""")
entries = []
for m in PATTERN.finditer(text):
    key = m.group(1)
    val = m.group(2) if m.group(2) is not None else m.group(3)
    val = val.replace("\\'", "'").replace('\\"', '"').replace("\\n", " ").strip()
    if len(val) < MIN_CHARS:
        continue
    if not any(s in val for s in SIGNAL):
        continue
    # 去掉 HTML 标签，保留文字
    plain = re.sub(r"<[^>]+>", "", val)
    plain = re.sub(r"\s+", " ", plain).strip()
    if len(plain) < MIN_CHARS:
        continue
    if plain.startswith("{") or "{" in plain:      # 含插值占位符的多为 UI 模板
        if plain.count("{") > 0 and len(plain) < 40:
            continue
    entries.append((key, plain))

# 服务条款段落单独收（它们较长、最权威）
terms = []
tm = re.search(r"serviceTerms\s*[:=]\s*\{(.*?)\n\s*\}\s*,?\s*\n", text, re.S)
if tm:
    for pm in re.finditer(r"paragraph\d+\s*:\s*'((?:[^'\\]|\\.)*)'", tm.group(1)):
        plain = re.sub(r"<[^>]+>", "", pm.group(1).replace("\\'", "'"))
        plain = re.sub(r"\s+", " ", plain).strip()
        if len(plain) >= 20:
            terms.append(plain)

# 去重并落盘
seen, passages = set(), []
for key, val in entries:
    if val in seen:
        continue
    seen.add(val)
    passages.append({"category": "前端提示", "title": f"EZ-THEME-R/{key}",
                     "heading": "", "brand": "general", "source": "theme", "text": val})
for i, t in enumerate(terms, 1):
    if t in seen:
        continue
    seen.add(t)
    passages.append({"category": "服务条款", "title": f"EZ-THEME-R/服务条款 第{i}段",
                     "heading": "", "brand": "general", "source": "theme", "text": t})

with open(OUT, "w", encoding="utf-8") as f:
    for p in passages:
        f.write(json.dumps(p, ensure_ascii=False) + "\n")

print(f"[来源] {SRC}")
print(f"[输出] 段落 {len(passages)} 个（i18n {len(passages)-len(terms)} + 服务条款 {len(terms)}）")
print(f"[字数] 共 {sum(len(p['text']) for p in passages)} 字")
print(f"[按 key 前缀分组] {dict(sorted(((k, sum(1 for p in passages if k in p['title'])) for k in ['errorCodes','common','auth','dashboard','notice','legal','terms','serviceTerms']), key=lambda x:-x[1]))}")
print("\n[服务条款全文]")
for i, t in enumerate(terms, 1):
    print(f"  {i}. {t[:200]}")
print("\n[样例提示文案]")
for p in passages[:5]:
    print(f"  · [{p['title']}] {p['text'][:110]}")
print(f"\n[已写] {OUT}")
