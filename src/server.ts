import crypto from 'crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import http from 'http';
import https from 'https';
import { config } from './config';
import { bot } from './bot';
import { saveMapping, saveTopic, getTopic, deleteTopic } from './database';
import { isSelfSentMessage, toggleTypingStatus } from './chatwoot';
import { createLogger } from './logger';
import type { ChatwootAttachment, ChatwootMessageEvent, ChatwootConversationStatusEvent } from './types';

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

    constructor(private ttlMs = 120_000) {
        this.timer = setInterval(() => this.cleanup(), this.ttlMs);
        this.timer.unref();
    }

    isDuplicate(key: string): boolean {
        if (this.seen.has(key)) return true;
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

// ============ Download Helpers ============

const TELEGRAM_MAX_FILE_SIZE_BYTES = 45 * 1024 * 1024;
const ATTACHMENT_CONCURRENCY = 2;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const downloadClient = axios.create({
    timeout: 20_000,
    maxRedirects: 5,
    httpAgent,
    httpsAgent,
    headers: { api_access_token: config.chatwootAccessToken },
    maxContentLength: TELEGRAM_MAX_FILE_SIZE_BYTES + 1024 * 1024,
    maxBodyLength: TELEGRAM_MAX_FILE_SIZE_BYTES + 1024 * 1024,
    validateStatus: (s) => s >= 200 && s < 400,
});

async function mapWithConcurrencyLimit<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
    if (items.length === 0) return;
    const realLimit = Math.max(1, Math.min(limit, items.length));
    let idx = 0;
    const runners = Array.from({ length: realLimit }, async () => {
        while (true) {
            const current = idx++;
            if (current >= items.length) return;
            await worker(items[current], current);
        }
    });
    await Promise.allSettled(runners);
}

function extractAttachments(event: ChatwootMessageEvent): ChatwootAttachment[] {
    if (Array.isArray(event?.attachments)) return event.attachments;
    if (Array.isArray(event?.message?.attachments)) return event.message.attachments;
    return [];
}

function pickAttachmentUrl(att: ChatwootAttachment): string | undefined {
    return att.data_url || att.file_url || att.download_url || att.url || att.thumb_url;
}

function parseDataUrl(dataUrl: string): { mimeType?: string; buffer: Buffer } | null {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
    if (!m) return null;
    return { mimeType: m[1], buffer: Buffer.from(m[2], 'base64') };
}

function guessTelegramSendKind(att: ChatwootAttachment, mimeType?: string): 'photo' | 'video' | 'audio' | 'document' {
    const ft = (att.file_type || '').toLowerCase();
    const mt = (mimeType || att.content_type || '').toLowerCase();
    if (ft === 'image' || mt.startsWith('image/')) return 'photo';
    if (ft === 'video' || mt.startsWith('video/')) return 'video';
    if (ft === 'audio' || mt.startsWith('audio/')) return 'audio';
    return 'document';
}

async function downloadAttachment(att: ChatwootAttachment): Promise<{ buffer: Buffer; mimeType?: string; filename: string; size: number; sourceUrl?: string }> {
    const filename = att.file_name || `attachment-${att.id || Date.now()}`;
    const url = pickAttachmentUrl(att);
    if (!url) throw new Error('附件缺少可下载的 URL');

    if (url.startsWith('data:')) {
        const parsed = parseDataUrl(url);
        if (!parsed) throw new Error('无法解析 data_url');
        return { buffer: parsed.buffer, mimeType: parsed.mimeType, filename, size: parsed.buffer.length };
    }

    const declaredSize = typeof att.file_size === 'number' ? att.file_size : (typeof att.size === 'number' ? att.size : undefined);
    if (declaredSize && declaredSize > TELEGRAM_MAX_FILE_SIZE_BYTES) {
        return { buffer: Buffer.alloc(0), filename, size: declaredSize, sourceUrl: url };
    }

    const resp = await downloadClient.get<ArrayBuffer>(url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(resp.data);
    const mimeTypeHeader = (resp.headers?.['content-type'] as string | undefined) || undefined;
    return { buffer, mimeType: mimeTypeHeader || att.content_type, filename, size: buffer.length, sourceUrl: url };
}

// ============ Forum Topics ============

async function getOrCreateTopic(conversationId: number, accountId: number, senderName: string): Promise<number | undefined> {
    if (!config.telegramForumChatId) return undefined;

    const existing = getTopic(conversationId);
    if (existing) return existing.telegram_topic_id;

    try {
        const topicName = `🗨️ ${senderName} #${conversationId}`;
        const result = await bot.telegram.createForumTopic(config.telegramForumChatId, topicName);
        const topicId = result.message_thread_id;
        saveTopic(conversationId, accountId, topicId, topicName);
        log.info('Created forum topic', { topicName, topicId, conversationId });
        await sendWelcomeMessage(conversationId, accountId, topicId);
        return topicId;
    } catch (err) {
        log.error('Failed to create forum topic', { conversationId, error: String(err) });
        return undefined;
    }
}

function buildForumInlineKeyboard(conversationId: number, accountId: number) {
    return {
        inline_keyboard: [
            [
                { text: '✅ 标记已解决', callback_data: `resolve:${conversationId}:${accountId}` },
                { text: '🔓 重新打开', callback_data: `reopen:${conversationId}:${accountId}` },
            ],
            [
                { text: '📱 在 Chatwoot 中查看', url: `${config.chatwootBaseUrl}/app/accounts/${accountId}/conversations/${conversationId}` },
            ],
        ],
    };
}

async function sendWelcomeMessage(conversationId: number, accountId: number, topicId: number) {
    if (!config.telegramForumChatId) return;
    try {
        await bot.telegram.sendMessage(
            config.telegramForumChatId,
            `💬 **新对话已开始**\n\n点击下方按钮管理此对话：`,
            {
                message_thread_id: topicId,
                parse_mode: 'Markdown',
                reply_markup: buildForumInlineKeyboard(conversationId, accountId),
            }
        );
    } catch (err) {
        log.error('Failed to send welcome message', { topicId, error: String(err) });
    }
}

async function closeTopicForConversation(conversationId: number): Promise<boolean> {
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

// ============ Attachment Sending ============

async function sendAttachmentToTelegram(params: {
    chatId: string;
    att: ChatwootAttachment;
    conversationId: number;
    accountId: number;
    chatwootMessageId?: number;
    messageThreadId?: number;
}) {
    const { chatId, att, conversationId, accountId, chatwootMessageId, messageThreadId } = params;
    const sendOptions: { message_thread_id?: number } = {};
    if (messageThreadId) sendOptions.message_thread_id = messageThreadId;

    const directUrl = pickAttachmentUrl(att);
    if (directUrl && !directUrl.startsWith('data:')) {
        const kind = guessTelegramSendKind(att, att.content_type);
        try {
            let sent;
            if (kind === 'photo') sent = await bot.telegram.sendPhoto(chatId, directUrl, sendOptions);
            else if (kind === 'video') sent = await bot.telegram.sendVideo(chatId, directUrl, sendOptions);
            else if (kind === 'audio') sent = await bot.telegram.sendAudio(chatId, directUrl, sendOptions);
            else sent = await bot.telegram.sendDocument(chatId, directUrl, sendOptions);
            saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
            return;
        } catch {
            log.warn('Direct URL send failed, falling back to download+upload', { filename: att.file_name });
        }
    }

    let downloaded: Awaited<ReturnType<typeof downloadAttachment>>;
    try {
        downloaded = await downloadAttachment(att);
    } catch (err) {
        log.error('Attachment download failed', { filename: att.file_name, error: String(err) });
        const url = pickAttachmentUrl(att);
        const sent = await bot.telegram.sendMessage(chatId, `📎 附件下载失败：${att.file_name || att.id || ''}\n${url ? `链接：${url}` : ''}`, sendOptions);
        saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
        return;
    }

    if (downloaded.size > TELEGRAM_MAX_FILE_SIZE_BYTES || downloaded.buffer.length === 0) {
        const url = downloaded.sourceUrl || pickAttachmentUrl(att);
        const sent = await bot.telegram.sendMessage(
            chatId,
            `📎 附件过大（${Math.ceil(downloaded.size / 1024 / 1024)}MB）\n文件：${downloaded.filename}\n${url ? `下载链接：${url}` : ''}`,
            sendOptions,
        );
        saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
        return;
    }

    const kind = guessTelegramSendKind(att, downloaded.mimeType);
    const inputFile = { source: downloaded.buffer, filename: downloaded.filename };

    try {
        let sent;
        if (kind === 'photo') sent = await bot.telegram.sendPhoto(chatId, inputFile, sendOptions);
        else if (kind === 'video') sent = await bot.telegram.sendVideo(chatId, inputFile, sendOptions);
        else if (kind === 'audio') sent = await bot.telegram.sendAudio(chatId, inputFile, sendOptions);
        else sent = await bot.telegram.sendDocument(chatId, inputFile, sendOptions);
        saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
    } catch (err) {
        log.error('Attachment send to Telegram failed', { filename: downloaded.filename, error: String(err) });
        const url = downloaded.sourceUrl || pickAttachmentUrl(att);
        const sent = await bot.telegram.sendMessage(chatId, `📎 附件发送失败：${downloaded.filename}\n${url ? `链接：${url}` : ''}`, sendOptions);
        saveMapping(sent.message_id, conversationId, accountId, chatwootMessageId);
    }
}

// ============ Message Handling ============

async function handleMessageCreated(event: ChatwootMessageEvent) {
    const messageType = event?.message_type;
    if (messageType !== 'incoming' && messageType !== 'outgoing') return;

    // Skip private/internal notes
    if (event?.private) return;

    // Prevent outgoing message loop: skip messages we sent ourselves
    if (messageType === 'outgoing' && isSelfSentMessage(event?.id)) {
        log.debug('Skipping self-sent outgoing message', { messageId: event?.id });
        return;
    }

    const conversationId = event?.conversation?.id;
    const accountId = event?.account?.id;
    if (!conversationId || !accountId) return;

    const attachments = extractAttachments(event);
    const messageContent = event?.content || (attachments.length > 0 ? '[附件]' : '[无内容]');
    const senderName = event?.sender?.name || '未知';
    const senderEmail = event?.sender?.email || '';

    const topicId = await getOrCreateTopic(conversationId, accountId, senderName);
    const isForumMode = !!topicId && !!config.telegramForumChatId;
    const chatId = isForumMode ? config.telegramForumChatId : config.telegramAdminId;

    let text = '';
    const attachmentHint = attachments.length > 0 ? `\n📎 附件：${attachments.length} 个` : '';
    if (messageType === 'incoming') {
        text = `👤 **${senderName}** (${senderEmail})\n💬 ${messageContent}${attachmentHint}`;
    } else {
        text = `🤖 **${senderName}** (客服/AI)\n📤 ${messageContent}${attachmentHint}`;
    }

    const replyMarkup = isForumMode
        ? buildForumInlineKeyboard(conversationId, accountId)
        : {
            inline_keyboard: [
                [{ text: '✅ 标记已解决', callback_data: 'resolve' }],
                [{ text: '📱 在 Chatwoot 中查看', url: `${config.chatwootBaseUrl}/app/accounts/${accountId}/conversations/${conversationId}` }],
            ],
        };

    const sendOptions = {
        parse_mode: 'Markdown' as const,
        message_thread_id: topicId,
        reply_markup: replyMarkup,
    };

    try {
        const sentMessage = await bot.telegram.sendMessage(chatId, text, sendOptions);
        saveMapping(sentMessage.message_id, conversationId, accountId, event?.id);

        await mapWithConcurrencyLimit(attachments, ATTACHMENT_CONCURRENCY, async (att) => {
            await sendAttachmentToTelegram({
                chatId,
                att,
                conversationId,
                accountId,
                chatwootMessageId: event?.id,
                messageThreadId: topicId,
            });
        });
    } catch (error: unknown) {
        const errObj = error as { response?: { description?: string }; message?: string };
        log.error('Failed to send message to Telegram', { conversationId, error: String(error) });

        if (errObj?.response?.description?.includes('TOPIC_DELETED') || errObj?.message?.includes('TOPIC_DELETED')) {
            log.info('Topic deleted, recreating', { conversationId });
            deleteTopic(conversationId);
            try {
                const newTopicId = await getOrCreateTopic(conversationId, accountId, senderName);
                if (newTopicId && config.telegramForumChatId) {
                    const newOpts = { ...sendOptions, message_thread_id: newTopicId };
                    const sentMessage = await bot.telegram.sendMessage(config.telegramForumChatId, text, newOpts);
                    saveMapping(sentMessage.message_id, conversationId, accountId, event?.id);
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

    if (status === 'resolved') {
        const closed = await closeTopicForConversation(conversationId);
        if (closed) log.info('Conversation resolved, topic closed', { conversationId });
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

    // Deduplication: skip already-processed events
    if (eventId && eventType) {
        const dedupKey = `${eventType}:${eventId}`;
        if (dedup.isDuplicate(dedupKey)) {
            log.debug('Duplicate webhook event skipped', { dedupKey });
            return;
        }
    }

    if (eventType === 'message_created') {
        void handleMessageCreated(event as ChatwootMessageEvent);
    } else if (eventType === 'conversation_status_changed') {
        void handleConversationStatusChanged(event as ChatwootConversationStatusEvent);
    }
});

export { closeTopicForConversation };
