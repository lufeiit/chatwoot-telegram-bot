import fs from 'fs';
import dotenv from 'dotenv';
import { createLogger } from './logger';
import { parseKeywordAutoReplyList, type KeywordAutoReply } from './keyword-auto-reply';

dotenv.config();

const log = createLogger('config');

/**
 * 加载关键词自动回复规则（全部配置都在 .env 中，不分文件）：
 *   · 新写法：KEYWORD_AUTO_REPLIES 用单引号包裹的 YAML 多行文本，条目可带 inbox 限定收件箱
 *   · 旧写法：单行 JSON，仍然兼容
 */
function loadAutoReplies(): KeywordAutoReply[] {
    try {
        const rules = parseKeywordAutoReplyList(process.env.KEYWORD_AUTO_REPLIES);
        log.info('Loaded keyword auto replies', {
            rules: rules.length,
            inboxSpecific: rules.filter(rule => rule.inboxIds?.length).length,
        });
        return rules;
    } catch (error) {
        log.error('Invalid KEYWORD_AUTO_REPLIES configuration', { error: String(error) });
        process.exit(1);
    }
}

const autoReplies = loadAutoReplies();

/** 解析布尔型环境变量，未设置或非真值返回 false */
function envBool(name: string, defaultValue = false): boolean {
    const v = process.env[name];
    if (v == null) return defaultValue;
    return /^(1|true|yes|on)$/i.test(v.trim());
}

/** 解析正整数型环境变量，未设置/非法时返回默认值 */
function envInt(name: string, defaultValue: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === '') return defaultValue;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultValue;
}

/**
 * 消息同步模式：
 *   webhook（默认）—— 仅接收 Chatwoot Webhook（需在 Chatwoot 后台配置）
 *   polling        —— 仅定时轮询 Chatwoot API（无需 Webhook，官方云收费时可用）
 *   both           —— 两者同时启用（共享去重，互为兼容保险）
 */
function parseSyncMode(raw: string | undefined): 'webhook' | 'polling' | 'both' {
    const value = (raw || '').trim().toLowerCase();
    if (value === 'polling' || value === 'both' || value === 'webhook') return value;
    if (value) log.warn(`Unknown CHATWOOT_SYNC_MODE "${raw}", falling back to webhook`);
    return 'webhook';
}

export const config = {
    port: process.env.PORT || 3000,
    telegramToken: process.env.TELEGRAM_TOKEN || '',
    telegramAdminId: process.env.TELEGRAM_ADMIN_ID || '',
    telegramForumChatId: process.env.TELEGRAM_FORUM_CHAT_ID || '',
    /** 启动时是否丢弃堆积的 Telegram 更新。默认 false，避免重启窗口期回复丢失。 */
    telegramDropPendingUpdates: envBool('TELEGRAM_DROP_PENDING_UPDATES', false),
    chatwootAccessToken: process.env.CHATWOOT_ACCESS_TOKEN || '',
    chatwootBaseUrl: (process.env.CHATWOOT_BASE_URL || 'https://app.chatwoot.com').replace(/\/+$/, ''),
    chatwootAccountId: process.env.CHATWOOT_ACCOUNT_ID || '',
    chatwootWebhookSecret: process.env.CHATWOOT_WEBHOOK_SECRET || '',
    /** 消息来源模式：webhook（默认）| polling | both */
    chatwootSyncMode: parseSyncMode(process.env.CHATWOOT_SYNC_MODE),
    /** 轮询间隔（秒），仅 polling / both 生效 */
    pollIntervalSeconds: envInt('POLL_INTERVAL_SECONDS', 10),
    /** 每轮最多检查的会话数（控制 API 请求量） */
    pollMaxConversations: envInt('POLL_MAX_CONVERSATIONS', 20),
    /** 首次遇到某会话时是否转发历史消息（默认 false，只记断点避免刷屏） */
    pollForwardHistory: envBool('POLL_FORWARD_HISTORY', false),
    /** 关键词自动回复规则（默认通用；条目可带 inbox 限定收件箱） */
    autoReplies,
    /** @deprecated 兼容旧字段，与 autoReplies 相同 */
    keywordAutoReplies: autoReplies,
    /** .env 文件路径（热加载用；容器内为 /app/.env，需由 docker-compose 挂载） */
    envFilePath: process.env.ENV_FILE_PATH || '.env',
    /** .env 变更检测间隔（秒）；0 = 关闭热加载 */
    envReloadIntervalSeconds: envInt('ENV_RELOAD_INTERVAL_SECONDS', 5),
    dbPath: process.env.DB_PATH || 'mappings.db',
};

const required: Array<[string, string]> = [
    ['TELEGRAM_TOKEN', config.telegramToken],
    ['TELEGRAM_ADMIN_ID', config.telegramAdminId],
    ['CHATWOOT_ACCESS_TOKEN', config.chatwootAccessToken],
    ['CHATWOOT_ACCOUNT_ID', config.chatwootAccountId],
];

const missing = required.filter(([, v]) => !v).map(([k]) => k);
if (missing.length > 0) {
    log.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
}

if (!config.chatwootWebhookSecret) {
    log.warn('CHATWOOT_WEBHOOK_SECRET is not set — webhook signature verification is disabled');
}

export interface ReloadResult {
    /** 是否真的重新加载了（文件无变化 / 不可读时为 false） */
    changed: boolean;
    /** 加载后的规则条数 */
    rules?: number;
    /** 其中带 inbox 限定的规则数 */
    inboxSpecific?: number;
    /** 失败原因（此时保留原规则，不会中断服务） */
    error?: string;
}

/**
 * 热加载关键词规则：重新读取 .env 中的 KEYWORD_AUTO_REPLIES 并替换内存中的规则。
 *
 * 说明：
 *   · **仅热加载关键词规则**；其余变量（Token / 端口 / 同步模式等）仍需重启容器生效
 *   · 解析失败时保留旧规则并返回 error（不会让服务崩溃）
 *   · 依赖 .env 被挂载进容器（docker-compose 里已加 `- ./.env:/app/.env:ro`）
 */
export function reloadKeywordAutoReplies(envFilePath?: string): ReloadResult {
    const filePath = envFilePath ?? config.envFilePath;

    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return { changed: false, error: `.env 不存在或不是文件：${filePath}（需要在 docker-compose 中挂载 .env）` };
        }

        const text = fs.readFileSync(filePath, 'utf8');
        const rules = parseKeywordAutoReplyList(dotenv.parse(text).KEYWORD_AUTO_REPLIES);

        config.autoReplies = rules;
        config.keywordAutoReplies = rules;

        return {
            changed: true,
            rules: rules.length,
            inboxSpecific: rules.filter(rule => rule.inboxIds?.length).length,
        };
    } catch (error) {
        return { changed: false, error: String(error) };
    }
}
