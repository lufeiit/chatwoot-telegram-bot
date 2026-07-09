import crypto from 'crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { bot } from './bot-instance';
import { saveMapping } from './database';
import { createMessageWithinConversationLock, isSelfSentMessage, conversationMutex } from './chatwoot';
import { createLogger, extractAxiosError } from './logger';
import { findKeywordAutoReply } from './keyword-auto-reply';
import { renderForwardedMessage, extractContactCard, extractSenderName } from './formatters';
import { extractAttachments, sendAttachmentsSequentially } from './attachments';
import {
    getOrCreateTopic,
    closeTopicForConversation,
    reopenTopicForConversation,
    dropTopic,
    buildForumInlineKeyboard,
    buildLegacyKeyboard,
} from './topics';
import type { ChatwootMessageEvent, ChatwootConversationStatusEvent } from './types';

const log = createLogger('server');

export const app = express();

// ============ Raw Body Capture for Signature Verification ============

interface RawBodyRequest extends Request {
    rawBody?: Buffer;
}

app.use(express.json({
    limit: '2mb',
    verify: (req: RawBodyRequest, _res: Response, buf: Buffer) => {
        req.rawBody = buf;
    },
} as Parameters<typeof express.json>[0]));

// ============ Webhook Signature Verification ============

function verifySignature(req: RawBodyRequest, res: Response, next: NextFunction): void {
    if (!config.chatwootWebhookSecret) {
        next();
        return;
    }

    const signatureHeader = req.headers['x-chatwoot-signature'];
    const timestampHeader = req.headers['x-chatwoot-timestamp'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;

    if (!signature) {
        log.warn('Webhook request missing X-Chatwoot-Signature header', { ip: req.ip });
        res.status(401).json({ error: 'Missing signature' });
        return;
    }

    if (!req.rawBody) {
        res.status(400).json({ error: 'Missing body' });
        return;
    }

    const normalizedSignature = signature.startsWith('sha256=')
        ? signature.slice('sha256='.length)
        : signature;

    const candidates = [
        crypto.createHmac('sha256', config.chatwootWebhookSecret).update(req.rawBody).digest('hex'),
    ];

    if (timestamp) {
        candidates.push(
            crypto
                .createHmac('sha256', config.chatwootWebhookSecret)
                .update(`${timestamp}.${req.rawBody.toString('utf8')}`)
                .digest('hex')
        );
    }

    const valid = candidates.some((candidate) => (
        candidate.length === normalizedSignature.length
        && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(normalizedSignature))
    ));

    if (!valid) {
        log.warn('Webhook signature verification failed', { ip: req.ip, hasTimestamp: !!timestamp });
        res.status(401).json({ error: 'Invalid signature' });
        return;
    }

    next();
}

// ============ Message Deduplication ============

class Deduplicator {
    private seen = new Map<string, number>();
    private timer: ReturnType<typeof setInterval>;

    constructor(private ttlMs = 120_000, private maxSize = 10_000) {
        this.timer = setInterval(() => this.cleanup(), this.ttlMs);
        this.timer.unref();
    }

    isDuplicate(key: string): boolean {
        if (this.seen.has(key)) return true;
        // 简单容量保护：超过上限时清理一次（再超就 LRU 淘汰最旧）
        if (this.seen.size >= this.maxSize) {
            this.cleanup();
            if (this.seen.size >= this.maxSize) {
                const oldestKey = this.seen.keys().next().value;
                if (oldestKey != null) this.seen.delete(oldestKey);
            }
        }
        this.seen.set(key, Date.now());
        return false;
    }

    private cleanup() {
        const cutoff = Date.now() - this.ttlMs;
        for (const [key, ts] of this.seen) {
            if (ts < cutoff) this.seen.delete(key);
        }
    }
}

const dedup = new Deduplicator();

// ============ Message Handling ============

async function handleMessageCreated(event: ChatwootMessageEvent) {
    const messageType = event?.message_type;
    if (messageType !== 'incoming' && messageType !== 'outgoing') {
        log.debug('Skipping non-message event', { messageType, eventId: event?.id });
        return;
    }

    // Skip private/internal notes
    if (event?.private) {
        log.debug('Skipping private message', { eventId: event?.id });
        return;
    }

    // Prevent outgoing message loop: skip messages we sent ourselves
    if (messageType === 'outgoing' && isSelfSentMessage(event?.id)) {
        log.debug('Skipping self-sent outgoing message', { messageId: event?.id });
        return;
    }

    const conversationId = event?.conversation?.id;
    const accountId = event?.account?.id;
    if (!conversationId || !accountId) {
        log.warn('Webhook event missing conversation or account ID', { conversationId, accountId, eventId: event?.id });
        return;
    }

    if (messageType === 'incoming' && event.content && config.keywordAutoReplies.length > 0) {
        const matchedReply = findKeywordAutoReply(event.content, config.keywordAutoReplies);
        if (matchedReply) {
            try {
                await createMessageWithinConversationLock(conversationId, matchedReply.reply);
                log.info('Keyword auto reply sent', {
                    conversationId,
                    keywords: matchedReply.keywords,
                    chatwootMessageId: event?.id,
                });
            } catch (error) {
                // 自动回复失败不能影响原有的 Telegram 消息转发。
                log.error('Failed to send keyword auto reply', {
                    conversationId,
                    keywords: matchedReply.keywords,
                    ...extractAxiosError(error),
                });
            }
        }
    }

    const attachments = extractAttachments(event);
    const messageContent = event?.content || (attachments.length > 0 ? '[附件]' : '[无内容]');
    const { name: senderName, email: senderEmail } = extractSenderName(event);
    const contactCard = extractContactCard(event);

    log.info('Processing webhook message', {
        conversationId,
        messageType,
        senderName,
        attachmentCount: attachments.length,
        contentPreview: messageContent.substring(0, 80),
        chatwootMessageId: event?.id,
    });

    const topicId = await getOrCreateTopic(conversationId, accountId, contactCard);
    const isForumMode = !!topicId && !!config.telegramForumChatId;
    const chatId = isForumMode ? config.telegramForumChatId : config.telegramAdminId;

    const text = renderForwardedMessage({
        messageType,
        senderName,
        senderEmail,
        content: messageContent,
        attachmentCount: attachments.length,
    });

    const replyMarkup = isForumMode
        ? buildForumInlineKeyboard(conversationId, accountId, contactCard.contactId)
        : buildLegacyKeyboard(conversationId, accountId);

    const sendOptions = {
        parse_mode: 'HTML' as const,
        message_thread_id: topicId,
        reply_markup: replyMarkup,
        link_preview_options: { is_disabled: true },
    };

    try {
        const sentMessage = await bot.telegram.sendMessage(chatId, text, sendOptions);
        saveMapping(sentMessage.message_id, conversationId, accountId, event?.id);
        log.debug('Message forwarded to Telegram', { conversationId, telegramMessageId: sentMessage.message_id });

        // 串行发送附件，保留顺序
        await sendAttachmentsSequentially(attachments, {
            chatId,
            conversationId,
            accountId,
            chatwootMessageId: event?.id,
            messageThreadId: topicId,
        });
    } catch (error: unknown) {
        const errObj = error as { response?: { description?: string }; message?: string };
        log.error('Failed to send message to Telegram', { conversationId, error: String(error) });

        if (errObj?.response?.description?.includes('TOPIC_DELETED') || errObj?.message?.includes('TOPIC_DELETED')) {
            log.info('Topic deleted, recreating', { conversationId });
            dropTopic(conversationId);
            try {
                const newTopicId = await getOrCreateTopic(conversationId, accountId, contactCard);
                if (newTopicId && config.telegramForumChatId) {
                    const newOpts = { ...sendOptions, message_thread_id: newTopicId };
                    const sentMessage = await bot.telegram.sendMessage(config.telegramForumChatId, text, newOpts);
                    saveMapping(sentMessage.message_id, conversationId, accountId, event?.id);
                    log.info('Message resent after topic recreation', { conversationId, newTopicId });
                }
            } catch (retryError) {
                log.error('Failed to recreate topic and resend', { conversationId, error: String(retryError) });
            }
        }
    }
}

async function handleConversationStatusChanged(event: ChatwootConversationStatusEvent) {
    const conversationId = event?.id || event?.conversation?.id;
    const status = event?.status;
    if (!conversationId) return;

    log.info('Conversation status changed', { conversationId, status });

    if (status === 'resolved') {
        const closed = await closeTopicForConversation(conversationId);
        if (closed) log.info('Conversation resolved, topic closed', { conversationId });
    } else if (status === 'open') {
        // 后台重开会话时，自动重开 Telegram 话题
        const reopened = await reopenTopicForConversation(conversationId);
        if (reopened) log.info('Conversation reopened, topic reopened', { conversationId });
    }
}

// ============ Routes ============

app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/webhook', verifySignature, (req: RawBodyRequest, res: Response) => {
    const event = req.body;
    res.sendStatus(200);

    const eventType = event?.event as string | undefined;
    const eventId = event?.id;

    log.debug('Webhook received', {
        eventType,
        eventId,
        conversationId: event?.conversation?.id,
        messageType: event?.message_type,
    });

    if (eventType === 'message_created' && eventId) {
        // dedup 只对 message_created 生效；status 变更可能短时间内多次
        // 触发（resolve→reopen→resolve），不能用同 key 去重
        const dedupKey = `${eventType}:${eventId}`;
        if (dedup.isDuplicate(dedupKey)) {
            log.debug('Duplicate webhook event skipped', { dedupKey });
            return;
        }
    }

    const convId = event?.conversation?.id || (eventType === 'conversation_status_changed' ? event?.id : undefined);

    const runner = async () => {
        if (eventType === 'message_created') {
            await handleMessageCreated(event as ChatwootMessageEvent);
        } else if (eventType === 'conversation_status_changed') {
            await handleConversationStatusChanged(event as ChatwootConversationStatusEvent);
        } else {
            log.debug('Unhandled webhook event type', { eventType });
        }
    };

    if (convId) {
        conversationMutex.runExclusive(`conv_${convId}`, runner).catch(err => {
            log.error('Webhook processing error', { error: String(err) });
        });
    } else {
        runner().catch(err => log.error('Webhook processing error', { error: String(err) }));
    }
});

export { closeTopicForConversation };
