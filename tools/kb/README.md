# 知识库构建脚本

把三处语义来源切段、标注、合并成 rag-api 使用的知识库文件（`kb/passages.jsonl`）。

## 三个来源

| # | 来源 | 说明 |
|---|---|---|
| ① | **v2board 教程** | `v2_knowledge` 表（HTML）。导出方式见下 |
| ② | **语雀文档** | 需要访问密码；抓取方式见下 |
| ③ | **EZ-THEME-R 前端提示** | i18n 文案 + 服务条款 / 购买须知 / 工单须知（权威政策原文） |

## 步骤

```bash
# ① v2board 教程：导出 TSV（换行会被转义；注意正文里的裸 \r，读取时必须 newline=''）
cd /www/wwwroot/v2board && set -a && . ./.env && set +a
mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USERNAME" -p"$DB_PASSWORD" -B -N --default-character-set=utf8mb4 \
  -e "SELECT id, language, category, title, body FROM lufei.v2_knowledge ORDER BY category, sort, id;" \
  > /opt/chatwoot-kb/knowledge_raw.tsv

# ① 切段（246 段）
python3 kb_chunk2.py            # → /opt/chatwoot-kb/passages.jsonl

# ② 语雀：需要访问密码。用 sink_yuque.py + 浏览器自动填表（密码从 .env 规则解析，全程不打印）
#    1) 启动取密/落盘端点：python3 sink_yuque.py         # 仅监听 127.0.0.1:8899
#    2) 浏览器打开语雀文档 → 页面内 fetch 取密 → 填表提交 → 抓正文 POST 回 /save/yuque_<slug>
#    3) python3 kb_yuque.py                              # → yuque_passages.jsonl
python3 kb_yuque.py

# ③ 前端提示 + 服务条款（98 段）
python3 kb_theme.py             # → /opt/chatwoot-kb/theme_passages.jsonl

# 合并三来源（含主题隔离标记：AppleID 类段落仅相关提问可检索）
python3 kb_merge.py             # → /opt/chatwoot-kb/passages_all.jsonl

# 部署到 rag-api
scp passages_all.jsonl <rag-host>:/opt/chatwoot-rag/kb/passages.jsonl
ssh <rag-host> 'cd /opt/chatwoot-rag && docker compose up -d --force-recreate rag-api'
```

## 关键约束

- **主题隔离**：段落可带 `topic`（当前只有 `appleid`）。带 topic 的段落，只有提问命中
  `RAG` 服务里 `TOPIC_TRIGGERS` 的触发词时才参与检索 —— 避免 AppleID 内容污染「退款」这类通用问题。
- **品牌隔离**：`brand` 为 `lufei` / `straycloud` / `general`；检索时同品牌 + general 可命中。
  教程与服务条款是两站通用，标 `general`。
- **切段粒度**：目标 ~400 字/段（`kb_chunk2.py` 的 `TARGET`），过碎会掉召回、过长会稀释语义。
- 排版换行不会变成消息换行：`.env` 规则用行尾 `\n`；知识库段落保留原文换行。

## 排查经验（踩过的坑）

- `mysql -B -N` 会转义 `\n` 但**不转义裸 `\r`**；Python 默认 universal-newline 会把 `\r` 当换行，
  导致「幽灵行」。读 TSV 必须 `open(..., newline="")`。
- 校准检索质量时，别把相似度矩阵对角线置 `-1` 后再查「自身的排名」——那必然是最后一名，recall 恒为 0。
- 单靠向量检索在这套语料上不够（recall@10 仅 11%）；**RRF 融合（向量 + BM25）** 提升到 24%，
  并入教程后 Top-5 含相关段落达 85%。
