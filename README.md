# Chatwoot Telegram Bot Bridge

<div align="center">

[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-lufeiit%2Fchatwoot--telegram--bot-blue?logo=github)](https://github.com/lufeiit/chatwoot-telegram-bot/pkgs/container/chatwoot-telegram-bot)
[![GitHub Actions](https://img.shields.io/github/actions/workflow/status/lufeiit/chatwoot-telegram-bot/docker-build.yml?branch=main&label=Docker%20Build)](https://github.com/lufeiit/chatwoot-telegram-bot/actions)
[![License](https://img.shields.io/github/license/lufeiit/chatwoot-telegram-bot)](./LICENSE)

一个轻量级、功能强大的 Chatwoot 和 Telegram 双向消息桥接服务。

[功能特性](#-功能特性) • [详细部署教程](#-详细部署教程) • [配置说明](#-配置说明) • [使用指南](#-使用指南) • [常见问题](#-常见问题)

</div>

---

## 📖 简介

这是一个连接 **Chatwoot** 和 **Telegram** 的中间件机器人。通过 Telegram Bot 直接接收和回复 Chatwoot 中的客户消息，让客服团队可以在 Telegram 中高效处理客户咨询，无需时刻盯着 Chatwoot 后台网页。

## ✨ 最新功能特性

- 🔄 **双向消息同步**：Chatwoot 客户消息实时推送到 Telegram，Telegram 回复自动同步到 Chatwoot。
- 💬 **Forum Topics 会话隔离**：每个客户对话自动在 Telegram 群组中创建独立话题（Topic），彻底解决多用户同时对话时的消息混乱问题。对话结束自动关闭话题。
- 📎 **全媒体格式支持**：支持双向发送图片、文档、视频、音频、语音、视频笔记（圆形视频）、贴纸和 GIF 动画。
- 📋 **预设回复 (Canned Responses)**：在 Telegram 中输入 `/canned` 命令，直接调用 Chatwoot 后台配置的快捷回复，支持翻页和搜索。
- 🤖 **关键词自动回复**：客户消息包含指定关键词时自动回复，可通过环境变量按需启用。
- 🛡️ **安全与稳定性增强**：
  - **Webhook 签名验证**：确保消息来源绝对安全。
  - **消息去重机制**：防止网络波动导致的消息重复发送。
  - **API 指数退避重试**：网络不稳定时自动重试，提升送达率。
  - **防消息死循环**：智能识别并过滤机器人自己发送的消息。
- 🎯 **便捷操作按钮**：一键标记会话为"已解决"、一键重新打开、快速跳转 Chatwoot 后台。
- ⌨️ **输入状态同步**：在 Telegram 中打字时，Chatwoot 网页端会实时显示“客服正在输入...”。

---

## 🚀 详细部署教程

部署本服务需要您具备一台可以访问外网的服务器（VPS），并已安装 Docker 和 Docker Compose。

### 第一步：准备工作（获取各项 Token 和 ID）

1. **获取 Telegram Bot Token**
   - 在 Telegram 中搜索并打开 [@BotFather](https://t.me/BotFather)。
   - 发送 `/newbot`，按提示设置机器人的名称（Name）和用户名（Username，必须以 bot 结尾）。
   - 创建成功后，BotFather 会发给你一串 Token（例如：`1234567890:ABCdefGhIJKlmNoPQRsTuvwxyZ`），请妥善保存。

2. **获取管理员的 Telegram User ID**
   - 在 Telegram 中搜索并打开 [@userinfobot](https://t.me/userinfobot)。
   - 点击 Start，它会回复你的 ID（一串纯数字，例如：`123456789`）。

3. **获取 Chatwoot Access Token 和 Account ID**
   - 登录你的 Chatwoot 后台。
   - 点击左下角头像 -> **Profile Settings** (个人设置)。
   - 滚动到页面最底部，找到 **Access Token** 并复制。
   - 查看浏览器地址栏，URL 格式通常为 `https://app.chatwoot.com/app/accounts/1/xxx`，其中的数字 `1` 就是你的 **Account ID**。

4. **准备 Telegram 话题群组（可选，但强烈推荐！）**
   - 在 Telegram 中创建一个新群组。
   - 将你刚才创建的 Bot 邀请进群，并**将其提升为管理员**（赋予所有权限，特别是 Manage Topics 权限）。
   - 点击群组顶部名称进入设置，点击右上角编辑（铅笔图标），找到 **Topics (话题/论坛)** 选项并**开启**。
   - 在群组中添加 [@RawDataBot](https://t.me/RawDataBot) 或使用第三方客户端，获取该群组的 Chat ID（通常以 `-100` 开头，例如：`-1001234567890`）。

### 第二步：服务器部署

> **无需克隆源码**：直接使用官方镜像 `ghcr.io/lufeiit/chatwoot-telegram-bot:latest`（同时支持 amd64 / arm64）。
> 只有需要本地二次开发时，才改为从源码构建（见 compose 文件里的注释）。

登录你的服务器，执行以下命令（部署目录只保存配置与数据）：

```bash
# 1. 创建并进入部署目录
mkdir -p /opt/chatwoot-telegram-bot && cd /opt/chatwoot-telegram-bot

# 2. 创建数据目录
mkdir data

# 3. 创建环境变量文件
nano .env
```

将以下内容复制到 `.env` 文件中，并替换为你自己的真实数据：

```env
# 容器内部监听端口（保持 3000 即可，不要改动，端口映射在 docker-compose 中配置）
PORT=3000

# Telegram 配置
TELEGRAM_TOKEN=你的_Telegram_Bot_Token
TELEGRAM_ADMIN_ID=你的_Telegram_User_ID
# 如果你开启了群组话题模式，填入群组ID（强烈推荐）；如果只用单聊模式，将此行注释掉
TELEGRAM_FORUM_CHAT_ID=-100xxxxxxxxxx
# 可选：启动时丢弃堆积的 Telegram 更新。默认 false（重启窗口期不丢消息）。
# TELEGRAM_DROP_PENDING_UPDATES=false

# Chatwoot 配置
CHATWOOT_BASE_URL=https://你的chatwoot域名.com
CHATWOOT_ACCESS_TOKEN=你的_Chatwoot_Access_Token
CHATWOOT_ACCOUNT_ID=1

# 可选：Webhook 签名验证密钥（在 Chatwoot Webhook 设置中生成后填入）
# CHATWOOT_WEBHOOK_SECRET=your_webhook_secret

# ── 关键词自动回复（配置全部写在 .env 里）──
# 推荐写法：每条规则之间空一行；回复分行书写，换行效果由行尾的 \n 控制（几个 \n 就空几行）
#   · 不写 inbox 的条目 = 默认规则，所有收件箱通用
#   · 需要差异化的条目上写 inbox（收件箱 ID，可单个或数组），只对该收件箱生效
#   · 按书写顺序匹配，第一条命中的生效（专属规则写在前面 = 专属优先）
#   · 也支持 reply: "单行\n文本" 写法；旧的单行 JSON 写法仍然兼容
# 完整示例见 .env.example
KEYWORD_AUTO_REPLIES='
- keywords: 人工 | 客服
  reply: |
    请稍等，已通知人工客服。\n\n
    人工客服时段：北京时间 9:00 - 21:00

- keywords: 价格
  inbox: 3
  reply: 该收件箱专属的价格说明
'

# 日志级别（debug / info / warn / error）
LOG_LEVEL=info

# 可选：日志写入文件 + 自动轮转
# LOG_TO_FILE=true            # 是否同时写入日志文件，默认 false（仅控制台）
# LOG_DIR=./logs              # 日志目录
# LOG_MAX_SIZE_MB=10          # 单文件大小上限，超过自动轮转
# LOG_MAX_FILES=3             # 保留的历史日志份数

# 可选：SQLite 数据库路径，默认 ./mappings.db（容器内 /app/data/mappings.db）
# DB_PATH=/app/data/mappings.db
```

#### 环境变量速查

| 变量 | 必填 | 默认值 | 说明 |
|---|:---:|---|---|
| `TELEGRAM_TOKEN` | ✅ | — | 从 @BotFather 获取的 Bot Token |
| `TELEGRAM_ADMIN_ID` | ✅ | — | 管理员 User ID（单聊模式必填） |
| `TELEGRAM_FORUM_CHAT_ID` | ⭕ | — | 话题群组 ID（推荐启用） |
| `TELEGRAM_DROP_PENDING_UPDATES` | ⭕ | `false` | 启动时是否丢弃堆积更新 |
| `CHATWOOT_BASE_URL` | ✅ | `https://app.chatwoot.com` | Chatwoot 后台地址（自动去尾斜杠） |
| `CHATWOOT_ACCESS_TOKEN` | ✅ | — | Personal Access Token |
| `CHATWOOT_ACCOUNT_ID` | ✅ | — | 账户 ID |
| `CHATWOOT_WEBHOOK_SECRET` | ⭕ | — | Webhook 签名密钥（Webhook 模式下强烈推荐设置） |
| `CHATWOOT_SYNC_MODE` | ⭕ | `webhook` | 消息来源：`webhook` / `polling` / `both`（云版 Webhook 不可用时用 `polling`） |
| `POLL_INTERVAL_SECONDS` | ⭕ | `10` | 轮询间隔（秒），仅 `polling` / `both` 生效 |
| `POLL_MAX_CONVERSATIONS` | ⭕ | `20` | 每轮最多检查的会话数（控制 API 请求量） |
| `POLL_FORWARD_HISTORY` | ⭕ | `false` | 首次遇到会话时是否转发历史消息（默认只记断点） |
| `ENV_RELOAD_INTERVAL_SECONDS` | ⭕ | `5` | .env 热加载检测间隔（秒），`0` = 关闭 |
| `ENV_FILE_PATH` | ⭕ | `.env` | 容器内 .env 路径（热加载用，默认 `/app/host/.env`，需 compose 目录挂载） |
| `KEYWORD_AUTO_REPLIES` | ⭕ | — | 自动回复规则：单引号包裹的 YAML 多行文本（不写 `inbox` = 通用；写 `inbox: <收件箱ID>` = 仅该收件箱生效）；兼容旧的单行 JSON |
| `PORT` | ⭕ | `3000` | Webhook 监听端口 |
| `LOG_LEVEL` | ⭕ | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_TO_FILE` | ⭕ | `false` | 是否写入日志文件 |
| `LOG_DIR` | ⭕ | `./logs` | 日志目录 |
| `LOG_MAX_SIZE_MB` | ⭕ | `10` | 单个日志文件大小上限（MB） |
| `LOG_MAX_FILES` | ⭕ | `3` | 保留的历史日志数 |
| `DB_PATH` | ⭕ | `mappings.db` | SQLite 数据库路径 |
| `NODE_ENV` | ⭕ | — | 设为 `production` 启用 JSON 结构化日志 |

保存并退出（在 nano 中按 `Ctrl+O`, `Enter`, `Ctrl+X`）。

接着创建 `docker-compose.yml` 文件：

```bash
nano docker-compose.yml
```

填入以下内容：

```yaml
services:
  bot:
    image: ghcr.io/lufeiit/chatwoot-telegram-bot:latest
    container_name: telegram-chatwoot-bot
    restart: unless-stopped
    ports:
      # 宿主机端口:容器端口。如果你想用 3123 端口接收 Webhook，这里就写 3123:3000
      - "3123:3000"
    volumes:
      - ./data:/app/data
    env_file:
      - .env
```

启动服务（首次会自动从 ghcr.io 拉取镜像，无需构建）：

```bash
docker compose pull     # 拉取/更新镜像
docker compose up -d

# 检查日志，确认是否启动成功
docker compose logs -f bot
```
*如果日志中显示 `Webhook server running on port 3000` 且没有报错，说明启动成功。*

### 第三步：配置 Chatwoot Webhook

1. 登录 Chatwoot 后台。
2. 进入 **设置 (Settings) → 集成 (Integrations) → Webhooks**。
3. 点击 **"Add new webhook"**。
4. 配置 Webhook：
   - **Webhook URL**: `http://你的服务器IP:3123/webhook` （注意端口号要和 docker-compose.yml 暴露的宿主机端口一致。如果你配置了反向代理和域名，请填写 `https://你的域名/webhook`）。
   - **Events**: 勾选 `message_created` 和 `conversation_status_changed`。
5. 保存。
6. （可选但推荐）保存后，Chatwoot 会生成一个 Webhook Secret。你可以将其复制，填入服务器的 `.env` 文件中的 `CHATWOOT_WEBHOOK_SECRET` 变量，然后执行 `docker compose restart bot`，以开启签名验证，防止恶意伪造请求。

### ☁️ 对接 Chatwoot 官方云服务（app.chatwoot.com）

本镜像与 Chatwoot **官方云版**完全兼容（用的是标准 REST API 与 Webhook 事件），不需要自建 Chatwoot：

1. `.env` 中指到官方云（`https://app.chatwoot.com` 也正是默认值）：

       CHATWOOT_BASE_URL=https://app.chatwoot.com
       CHATWOOT_ACCESS_TOKEN=你的_Access_Token   # 后台：头像 → Profile Settings → Access Token
       CHATWOOT_ACCOUNT_ID=1                     # 后台 URL 里的 /app/accounts/<ID>/

2. 在官方云后台配置 Webhook（**必需**）：
   - 进入 **设置 (Settings) → 集成 (Integrations) → Webhooks → Add new webhook**
   - **URL**：`https://你的域名/webhook`（没有域名时可用 `http://服务器IP:3123/webhook`）
   - **Events**：勾选 `message_created`（必需）与 `conversation_status_changed`（推荐，用于自动归档话题）
   - 保存后把生成的 **Secret** 填入 `.env` 的 `CHATWOOT_WEBHOOK_SECRET`，再执行 `docker compose restart bot`
3. 服务器需要**公网可达**（或 Nginx 反代 + 域名 + HTTPS），因为消息是 Chatwoot 主动推送过来的。

#### 🔄 两种消息来源模式：Webhook 与轮询

| 模式 | 配置 | 实时性 | 适用场景 |
|---|---|---|---|
| `webhook`（默认） | 不设置，或 `CHATWOOT_SYNC_MODE=webhook` | 实时 | 自建 Chatwoot；或云版套餐含 Webhook |
| `polling` | `CHATWOOT_SYNC_MODE=polling` | 秒级延迟（默认 10s） | **云版 Webhook 不可用/收费**时；无需公网可达地址 |
| `both` | `CHATWOOT_SYNC_MODE=both` | 实时 | 双保险：Webhook + 轮询兜底（共享去重，不会重复转发） |

轮询模式的可调参数：

| 变量 | 默认 | 说明 |
|---|---|---|
| `POLL_INTERVAL_SECONDS` | `10` | 轮询间隔（秒） |
| `POLL_MAX_CONVERSATIONS` | `20` | 每轮最多检查的会话数 |
| `POLL_FORWARD_HISTORY` | `false` | 首次遇到会话时是否转发历史消息（默认只记断点，避免刷屏）|

**轮询原理**：定时拉取「最近活跃的会话列表」（1 次请求）→ 对每个会话按本地断点增量拉取（`messages?after=<上次消息ID>`）→ 新消息走与 Webhook **完全相同**的转发逻辑 → 断点存 SQLite（`poll_state` 表），重启不丢、天然去重；遇 `429` 自动指数退避（尊重 `Retry-After`）。

请求量参考：10 秒间隔 × 20 个会话 ≈ 每分钟 120 次请求，远低于自建版默认的全局限流（3000 次/分钟/IP）。

**轮询模式下不再需要**：公网可达地址、Nginx 反代、Chatwoot 后台的 Webhook 配置。

#### ⚠️ 各功能的依赖情况

| 功能 | 依赖 |
|---|---|
| 客户消息 → Telegram（话题 / 卡片） | Webhook **或** 轮询皆可 |
| 关键词自动回复（含按收件箱区分） | Webhook **或** 轮询皆可 |
| 会话状态同步（自动归档 / 重开话题） | Webhook **或** 轮询皆可（轮询通过 `last_status` 比对检测） |
| Telegram 回复 / 发图 / `/canned` / 按钮 / 打字状态 | 无需额外配置，但需先收到消息（即依赖上面任一模式） |
| `/health` | 不需要 |

**注意**：若两种模式都未生效（默认 `webhook` 模式但未在 Chatwoot 配置 Webhook），服务会正常启动但不会有任何业务动作。

另外，**Webhook 签名验证可以不开启**：`CHATWOOT_WEBHOOK_SECRET` 留空时代码会放行所有请求（仅打一条告警）。但**强烈建议开启**，否则任何知道该地址的人都能伪造客户消息（轮询模式下该变量无意义）。

#### 🔥 配置热加载（改关键词规则无需重启）

默认的 `docker-compose.yml` 已把**部署目录本身**以只读方式挂载进容器（`- ./:/app/host:ro`），并在
`.env` 中设置 `ENV_FILE_PATH=/app/host/.env`，所以：

1. 直接在服务器上编辑 `.env`，修改 `KEYWORD_AUTO_REPLIES`
2. **无需重启**，默认 5 秒内自动生效（日志：`关键词规则已热加载（无需重启）`）
3. 想立即生效也可以：`docker compose kill -s HUP bot`

注意事项：

- **仅关键词规则支持热加载**；其他变量（Token / 端口 / 同步模式 / 轮询间隔 / 日志级别等）修改后仍需 `docker compose restart bot`
- 规则写错时**保留原规则**并打印错误日志，服务不会崩溃（可用 `docker compose logs -f bot` 查看）
- `ENV_RELOAD_INTERVAL_SECONDS=0` 可关闭热加载；若未挂载，热加载会静默跳过（不影响服务）

> **为什么挂目录而不是挂 `.env` 文件？**
> Docker 的**文件**挂载是按 inode 绑定的：容器启动那一刻锁死 `.env` 的 inode。
> 之后用 `mv` 或 `vim`（默认 `backupcopy=auto` 走 rename）覆盖 `.env`，会生成新 inode ——
> 容器依旧读到旧内容，**热加载会静默失效、不报任何错**。
> 挂目录则每次打开文件都重新解析路径，任何编辑器、任何写入方式都不会失联。

### ⚠️ 重要：Nginx 反向代理配置

如果你的 Webhook URL 使用了域名和 Nginx 反向代理，**必须**在 Nginx 配置中添加允许下划线 Header 的指令，否则下载附件时会报 401 错误：

```nginx
server {
    server_name 你的域名;

    # 必须开启：允许包含下划线的 HTTP Header (api_access_token)
    underscores_in_headers on;

    location / {
        proxy_pass http://127.0.0.1:3123;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

重载 Nginx：`sudo systemctl reload nginx`

---

## 📱 使用指南

### 🆕 话题隔离模式（Forum Topics）- 强烈推荐

这是最高效的客服工作方式。
1. 当 Chatwoot 有新客户发送消息时，Bot 会自动在你的 Telegram 群组中创建一个新的话题（Topic），名称格式为 `🗨️ 客户名 #对话ID`。
2. 你只需要点击进入该话题，**直接发送文字或图片**，消息就会自动同步给该客户。
3. 话题内支持使用 `/canned` 命令快速调用预设回复。
4. 消息下方会附带控制按钮，点击 **"✅ 标记已解决"**，Chatwoot 中的会话将被关闭，同时 Telegram 中的这个话题也会被自动关闭（归档）。

### 💬 普通单聊模式

如果你没有配置 `TELEGRAM_FORUM_CHAT_ID`，Bot 会直接私聊发消息给管理员。
- **回复客户时，必须在 Telegram 中长按客户的消息，选择“回复 (Reply)”，然后再输入内容。** 否则 Bot 无法知道你是在回复哪位客户。
- 同样支持点击按钮标记已解决或重新打开。

---

## ❓ 常见问题排查

**1. 机器人没有在群组里创建话题？**
- 检查群组是否开启了 "Topics (话题)" 功能（群组设置中开启）。
- 检查 Bot 是否是群组管理员，且拥有 "Manage Topics (管理话题)" 权限。
- 检查 `.env` 中的 `TELEGRAM_FORUM_CHAT_ID` 是否填写正确（通常带 `-100` 前缀）。

**2. 日志报错 `Error: 409: Conflict: terminated by other getUpdates request`**
- 说明你有两个相同的 Bot 实例在同时运行。请确保你没有在其他服务器或后台使用 `node` 运行同一个 Bot Token。执行 `docker ps` 检查是否有重复容器。

**3. Webhook 无法接收消息？**
- 检查 Chatwoot 后台填写的 Webhook URL 端口是否与 `docker-compose.yml` 中映射的外部端口一致。
- 检查服务器防火墙（如 ufw、宝塔面板、云服务商安全组）是否放行了该端口。
- 检查 `.env` 中的 `PORT` 必须保持为 `3000`（这是容器内部监听端口，不要改成外部端口）。

**4. 无法发送/接收图片附件？**
- 如果使用了 Nginx 反向代理 Chatwoot，请务必在 Nginx 配置中加上 `underscores_in_headers on;`。

## 🏗️ 技术架构

- **运行时**: Node.js 20 (Alpine)
- **语言**: TypeScript
- **框架**: Telegraf (Telegram Bot), Express (Webhook Server)
- **数据库**: SQLite3 (持久化消息映射)

## 🤝 贡献与支持

欢迎提交 Issue 和 Pull Request！如果这个项目对您有帮助，请给个 ⭐ Star！

当前仓库：[lufeiit/chatwoot-telegram-bot](https://github.com/lufeiit/chatwoot-telegram-bot)

MIT License © 2025 [Shannon-x](https://github.com/Shannon-x)
