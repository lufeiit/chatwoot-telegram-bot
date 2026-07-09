import dotenv from 'dotenv';
import { createLogger } from './logger';
import { parseKeywordAutoReplies } from './keyword-auto-reply';

dotenv.config();

const log = createLogger('config');

function loadKeywordAutoReplies() {
    try {
        return parseKeywordAutoReplies(process.env.KEYWORD_AUTO_REPLIES);
    } catch (error) {
        log.error('Invalid KEYWORD_AUTO_REPLIES configuration', { error: String(error) });
        process.exit(1);
    }
}

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
    keywordAutoReplies: loadKeywordAutoReplies(),
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
