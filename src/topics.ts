import { bot } from './bot-instance';
import { config } from './config';
import { saveTopic, getTopic, deleteTopic } from './database';
import { createLogger } from './logger';
import { renderContactCard } from './formatters';
import type { ContactCardInfo } from './types';

const log = createLogger('topics');

export function buildForumInlineKeyboard(conversationId: number, accountId: number) {
    return {
        inline_keyboard: [
            [
                { text: '✅ 标记已解决', callback_data: `r:${conversationId}:${accountId}` },
                { text: '🔓 重新打开', callback_data: `o:${conversationId}:${accountId}` },
            ],
            [
                { text: '📱 在 Chatwoot 中查看', url: `${config.chatwootBaseUrl}/app/accounts/${accountId}/conversations/${conversationId}` },
            ],
        ],
    };
}

export function buildLegacyKeyboard(conversationId: number, accountId: number) {
    return {
        inline_keyboard: [
            [{ text: '✅ 标记已解决', callback_data: 'resolve' }],
            [{ text: '📱 在 Chatwoot 中查看', url: `${config.chatwootBaseUrl}/app/accounts/${accountId}/conversations/${conversationId}` }],
        ],
    };
}

/**
 * 获取或新建 forum topic。
 * 新建后立即推送联系人完整卡片（如果提供了 contactInfo）。
 */
export async function getOrCreateTopic(
    conversationId: number,
    accountId: number,
    contactInfo: ContactCardInfo,
): Promise<number | undefined> {
    if (!config.telegramForumChatId) return undefined;

    const existing = getTopic(conversationId);
    if (existing) {
        log.debug('Using existing forum topic', { conversationId, topicId: existing.telegram_topic_id });
        return existing.telegram_topic_id;
    }

    try {
        const topicName = `🗨️ ${contactInfo.name} #${conversationId}`;
        const result = await bot.telegram.createForumTopic(config.telegramForumChatId, topicName);
        const topicId = result.message_thread_id;
        saveTopic(conversationId, accountId, topicId, topicName);
        log.info('Created forum topic', { topicName, topicId, conversationId });
        await sendContactCard(conversationId, accountId, topicId, contactInfo);
        return topicId;
    } catch (err) {
        log.error('Failed to create forum topic', { conversationId, error: String(err) });
        return undefined;
    }
}

/** 话题创建后发送联系人完整卡片（HTML） */
async function sendContactCard(
    conversationId: number,
    accountId: number,
    topicId: number,
    contactInfo: ContactCardInfo,
) {
    if (!config.telegramForumChatId) return;
    try {
        const text = renderContactCard(contactInfo, conversationId);
        await bot.telegram.sendMessage(config.telegramForumChatId, text, {
            message_thread_id: topicId,
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: buildForumInlineKeyboard(conversationId, accountId),
        });
    } catch (err) {
        log.error('Failed to send contact card', { topicId, error: String(err) });
    }
}

export async function closeTopicForConversation(conversationId: number): Promise<boolean> {
    if (!config.telegramForumChatId) return false;
    const topic = getTopic(conversationId);
    if (!topic) return false;
    try {
        await bot.telegram.closeForumTopic(config.telegramForumChatId, topic.telegram_topic_id);
        log.info('Closed forum topic', { conversationId, topicId: topic.telegram_topic_id });
        return true;
    } catch (err) {
        log.error('Failed to close forum topic', { conversationId, error: String(err) });
        return false;
    }
}

export async function reopenTopicForConversation(conversationId: number): Promise<boolean> {
    if (!config.telegramForumChatId) return false;
    const topic = getTopic(conversationId);
    if (!topic) return false;
    try {
        await bot.telegram.reopenForumTopic(config.telegramForumChatId, topic.telegram_topic_id);
        log.info('Reopened forum topic', { conversationId, topicId: topic.telegram_topic_id });
        return true;
    } catch (err) {
        log.debug('Failed to reopen forum topic (may already be open)', { conversationId, error: String(err) });
        return false;
    }
}

export function dropTopic(conversationId: number) {
    deleteTopic(conversationId);
}
