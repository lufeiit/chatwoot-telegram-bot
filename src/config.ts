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
    /** 关键词自动回复规则（默认通用；条目可带 inbox 限定收件箱） */
    autoReplies,
    /** @deprecated 兼容旧字段，与 autoReplies 相同 */
    keywordAutoReplies: autoReplies,
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
