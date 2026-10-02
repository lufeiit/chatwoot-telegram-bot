#!/usr/bin/env python3
"""把语雀正文转成知识库段落。

品牌归属：信息公告按站点区分（路飞云→lufei，迷途云→straycloud），故障排查两类用户共用→general。
"""
import glob
import json
import os
import re

KB_DIR = "/opt/chatwoot-kb"
OUT = f"{KB_DIR}/yuque_passages.jsonl"
TARGET = 420
MAX_CHARS = 900
MIN_CHARS = 30

META = {
    "zttgx31gg811howp": ("路飞云 信息公告", "lufei", "语雀/信息公告"),
    "lxvz3lmpwiotb6tm": ("迷途云 信息公告", "straycloud", "语雀/信息公告"),
    "zrugrwa5gz4l3gsa": ("故障排查建议", "general", "语雀/故障排查"),
}


def chunks(text):
    """按空行/标题切，合并到 TARGET 左右，硬上限 MAX_CHARS。"""
    text = re.sub(r"\n{3,}", "\n\n", text.replace("\r", "\n")).strip()
    blocks = [b.strip() for b in re.split(r"\n\s*\n", text) if b.strip()]
    out, buf = [], []
    for b in blocks:
        if any(len(x) for x in buf) and sum(len(x) + 1 for x in buf) + len(b) > TARGET:
            out.append("\n".join(buf))
            buf = []
        buf.append(b)
    if buf:
        out.append("\n".join(buf))
    res = []
    for c in out:
        if len(c) <= MAX_CHARS:
            res.append(c)
        else:
            for i in range(0, len(c), MAX_CHARS):
                res.append(c[i:i + MAX_CHARS])
    return [c for c in res if len(c) >= MIN_CHARS]


passages = []
for path in sorted(glob.glob(f"{KB_DIR}/save_yuque_*.txt")):
    slug = os.path.basename(path)[len("save_yuque_"):-len(".txt")]
    title, brand, category = META.get(slug, (f"语雀文档 {slug}", "general", "语雀"))
    text = open(path, encoding="utf-8").read()
    # 去掉页面噪音（点赞、举报、页脚等）
    text = re.split(r"若有收获，就点个赞吧", text)[0]
    for i, c in enumerate(chunks(text)):
        passages.append({"category": category, "title": title, "heading": "",
                         "brand": brand, "source": "yuque", "topic": "",
                         "text": c})

with open(OUT, "w", encoding="utf-8") as f:
    for p in passages:
        f.write(json.dumps(p, ensure_ascii=False) + "\n")

print(f"[输出] 语雀段落 {len(passages)} 个，共 {sum(len(p['text']) for p in passages)} 字")
for p in passages:
    print(f"  · [{p['category']}/{p['brand']}] {len(p['text'])}字  {p['text'][:90]}".replace("\n", " "))
print(f"[已写] {OUT}")
