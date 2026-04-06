import { Telegraf, Context } from 'telegraf';
import type { Message, CallbackQuery } from 'telegraf/types';
import { config } from './config';
import { getMapping, getTopic, getTopicByTopicId } from './database';
import {
    createMessage,
    createMessageWithAttachment,
    toggleConversationStatus,
    toggleTypingStatus,
    getCannedResponses,
} from './chatwoot';
import { createLogger, extractAxiosError } from './logger';

const log = createLogger('bot');

export const bot = new Telegraf(config.telegramToken);

// ============ Helpers ============

type TextMessage = Message.TextMessage;
type PhotoMessage = Message.PhotoMessage;
type DocumentMessage = Message.DocumentMessage;
type VideoMessage = Message.VideoMessage;
type AudioMessage = Message.AudioMessage;
type VoiceMessage = Message.VoiceMessage;
type VideoNoteMessage = Message.VideoNoteMessage;
type StickerMessage = Message.StickerMessage;
type AnimationMessage = Message.AnimationMessage;

function isFromForum(ctx: Context): boolean {
    return !!config.telegramForumChatId && ctx.chat?.id.toString() === config.telegramForumChatId;
}

function isAdmin(ctx: Context): boolean {
    return ctx.from?.id.toString() === config.telegramAdminId;
}

/**
 * Set a reaction emoji on a message to provide visual feedback.
 * Silently fails since reactions are non-critical.
 */
async function setMessageReaction(chatId: string | number, messageId: number, emoji: string): Promise<void> {
    try {
        await (bot.telegram as any).callApi('setMessageReaction', {
            chat_id: chatId,
            message_id: messageId,
            reaction: [{ type: 'emoji', emoji }],
        });
    } catch (err) {
        log.debug('Failed to set message reaction (non-critical)', { chatId, messageId, emoji, error: String(err) });
    }
}

/**
 * Resolve the Chatwoot conversation ID from either forum topic or reply context.
 * Returns null if no mapping found.
 */
function resolveConversationId(ctx: Context & { message?: Message }): number | null {
    if (isFromForum(ctx)) {
        const threadId = (ctx.message as Message & { message_thread_id?: number })?.message_thread_id;
        if (threadId) {
            const mapping = getTopicByTopicId(threadId);
            if (mapping) {
                log.debug('Resolved conversation from forum topic', { threadId, conversationId: mapping.chatwoot_conversation_id });
            } else {
                log.debug('No conversation mapping found for forum topic', { threadId });
            }
            return mapping ? mapping.chatwoot_conversation_id : null;
        }
        log.debug('Forum message has no thread ID');
        return null;
    }

    if (!isAdmin(ctx)) {
        log.debug('Message from non-admin user, ignoring', { userId: ctx.from?.id });
        return null;
    }

    const replyTo = (ctx.message as Message & { reply_to_message?: Message })?.reply_to_message;
    if (!replyTo) return null;

    const mapping = getMapping(replyTo.message_id);
    if (mapping) {
        log.debug('Resolved conversation from reply', { replyMessageId: replyTo.message_id, conversationId: mapping.chatwoot_conversation_id });
    } else {
        log.debug('No conversation mapping found for reply', { replyMessageId: replyTo.message_id });
    }
    return mapping ? mapping.chatwoot_conversation_id : null;
}

// ============ /canned Command ============

const CANNED_PAGE_SIZE = 8;

bot.command('canned', async (ctx) => {
    const conversationId = resolveConversationId(ctx);
    if (!conversationId) {
        await ctx.reply('请在对话话题中使用此命令，或回复一条客户消息。');
        return;
    }

    try {
        const searchTerm = ctx.message.text.replace(/^\/canned\s*/, '').trim() || undefined;
        const responses = await getCannedResponses(searchTerm);

        if (responses.length === 0) {
            await ctx.reply(searchTerm ? `未找到匹配 "${searchTerm}" 的预设回复。` : '暂无预设回复。');
            return;
        }

        await sendCannedResponsePage(ctx, responses, 0, conversationId);
    } catch (error) {
        log.error('Failed to fetch canned responses', extractAxiosError(error));
        await ctx.reply('获取预设回复失败，请检查日志。');
    }
});

function buildCannedKeyboard(responses: Array<{ id: number; short_code: string }>, page: number, conversationId: number) {
    const start = page * CANNED_PAGE_SIZE;
    const pageItems = responses.slice(start, start + CANNED_PAGE_SIZE);
    const totalPages = Math.ceil(responses.length / CANNED_PAGE_SIZE);

    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < pageItems.length; i += 2) {
        const row: Array<{ text: string; callback_data: string }> = [];
        row.push({ text: `💬 ${pageItems[i].short_code}`, callback_data: `canned:${pageItems[i].id}:${conversationId}` });
        if (i + 1 < pageItems.length) {
            row.push({ text: `💬 ${pageItems[i + 1].short_code}`, callback_data: `canned:${pageItems[i + 1].id}:${conversationId}` });
        }
        rows.push(row);
    }

    if (totalPages > 1) {
        const navRow: Array<{ text: string; callback_data: string }> = [];
        if (page > 0) navRow.push({ text: '⬅️ 上一页', callback_data: `canned_page:${page - 1}:${conversationId}` });
        navRow.push({ text: `📄 ${page + 1}/${totalPages}`, callback_data: 'noop' });
        if (start + CANNED_PAGE_SIZE < responses.length) navRow.push({ text: '➡️ 下一页', callback_data: `canned_page:${page + 1}:${conversationId}` });
        rows.push(navRow);
    }

    rows.push([{ text: '❌ 关闭', callback_data: 'canned_close' }]);

    return { inline_keyboard: rows };
}

async function sendCannedResponsePage(ctx: Context, responses: Array<{ id: number; short_code: string; content: string }>, page: number, conversationId: number) {
    const keyboard = buildCannedKeyboard(responses, page, conversationId);
    const text = `📋 **预设回复** (共 ${responses.length} 条)\n选择要发送的回复：`;

    await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
    });
}

// ============ Text Message Handler ============

bot.on('text', async (ctx) => {
    const msg = ctx.message as TextMessage;

    // Skip bot commands (already handled above)
    if (msg.text.startsWith('/')) return;

    if (isFromForum(ctx)) {
        const threadId = msg.message_thread_id;
        if (!threadId) return;

        const topicMapping = getTopicByTopicId(threadId);
        if (!topicMapping) return;

        log.debug('Processing forum text message', {
            threadId,
            conversationId: topicMapping.chatwoot_conversation_id,
            textPreview: msg.text.substring(0, 80),
        });

        try {
            void toggleTypingStatus(topicMapping.chatwoot_conversation_id, 'on');
            await createMessage(topicMapping.chatwoot_conversation_id, msg.text);
            // ✅ React to confirm successful delivery
            await setMessageReaction(ctx.chat.id, msg.message_id, '✅');
            log.info('Forum message sent to Chatwoot', { conversationId: topicMapping.chatwoot_conversation_id });
        } catch (error) {
            log.error('Failed to send forum message to Chatwoot', {
                conversationId: topicMapping.chatwoot_conversation_id,
                ...extractAxiosError(error),
            });
            await setMessageReaction(ctx.chat.id, msg.message_id, '❌');
            await ctx.reply('❌ 发送消息到 Chatwoot 失败，请查看日志。');
        }
        return;
    }

    if (!isAdmin(ctx)) return;

    const replyTo = msg.reply_to_message;
    if (!replyTo) {
        await ctx.reply('请回复客户消息来发送回复。');
        return;
    }

    const mapping = getMapping(replyTo.message_id);
    if (!mapping) {
        await ctx.reply('找不到与此消息关联的会话。可能已过期或不是来自机器人。');
        return;
    }

    log.debug('Processing admin reply message', {
        conversationId: mapping.chatwoot_conversation_id,
        replyToMessageId: replyTo.message_id,
        textPreview: msg.text.substring(0, 80),
    });

    try {
        void toggleTypingStatus(mapping.chatwoot_conversation_id, 'on');
        await createMessage(mapping.chatwoot_conversation_id, msg.text);
        // ✅ React to confirm successful delivery
        await setMessageReaction(ctx.chat.id, msg.message_id, '✅');
        log.info('Admin reply sent to Chatwoot', { conversationId: mapping.chatwoot_conversation_id });
    } catch (error) {
        log.error('Failed to send admin reply to Chatwoot', {
            conversationId: mapping.chatwoot_conversation_id,
            ...extractAxiosError(error),
        });
        await setMessageReaction(ctx.chat.id, msg.message_id, '❌');
        await ctx.reply('❌ 发送消息到 Chatwoot 失败，请查看日志。');
    }
});

// ============ Callback Query Handler ============

bot.on('callback_query', async (ctx) => {
    const cbQuery = ctx.callbackQuery as CallbackQuery.DataQuery;
    const data = cbQuery.data;
    if (!data) return;

    // Canned response: send selected response to conversation
    if (data.startsWith('canned:')) {
        const parts = data.split(':');
        const responseId = parseInt(parts[1], 10);
        const conversationId = parseInt(parts[2], 10);

        if (!responseId || !conversationId) {
            await ctx.answerCbQuery('参数错误');
            return;
        }

        try {
            const responses = await getCannedResponses();
            const selected = responses.find(r => r.id === responseId);
            if (!selected) {
                await ctx.answerCbQuery('预设回复已不存在');
                return;
            }

            void toggleTypingStatus(conversationId, 'on');
            await createMessage(conversationId, selected.content);
            await ctx.answerCbQuery(`✅ 已发送: ${selected.short_code}`);

            try {
                await ctx.editMessageText(
                    `✅ 已发送预设回复 **${selected.short_code}**\n\n> ${selected.content.substring(0, 200)}${selected.content.length > 200 ? '...' : ''}`,
                    { parse_mode: 'Markdown' },
                );
            } catch {
                // edit may fail if message is too old
            }
        } catch (error) {
            log.error('Failed to send canned response', { responseId, conversationId, ...extractAxiosError(error) });
            await ctx.answerCbQuery('❌ 发送失败，请重试');
        }
        return;
    }

    // Canned pagination
    if (data.startsWith('canned_page:')) {
        const parts = data.split(':');
        const page = parseInt(parts[1], 10);
        const conversationId = parseInt(parts[2], 10);

        try {
            const responses = await getCannedResponses();
            const keyboard = buildCannedKeyboard(responses, page, conversationId);
            const text = `📋 **预设回复** (共 ${responses.length} 条)\n选择要发送的回复：`;
            await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
            await ctx.answerCbQuery();
        } catch (error) {
            log.error('Failed to paginate canned responses', extractAxiosError(error));
            await ctx.answerCbQuery('加载失败');
        }
        return;
    }

    // Close canned response menu
    if (data === 'canned_close') {
        try {
            await ctx.deleteMessage();
        } catch {
            try { await ctx.editMessageText('已关闭'); } catch { /* ignore */ }
        }
        await ctx.answerCbQuery();
        return;
    }

    // Noop (page indicator button)
    if (data === 'noop') {
        await ctx.answerCbQuery();
        return;
    }

    // Forum mode: resolve conversation
    if (data.startsWith('resolve:')) {
        const parts = data.split(':');
        const conversationId = parseInt(parts[1], 10);
        const accountId = parseInt(parts[2], 10);

        if (!conversationId) return;

        try {
            await toggleConversationStatus(conversationId, 'resolved');
            await ctx.answerCbQuery('✅ 会话已标记为已解决，话题将自动关闭！');

            const messageText = (cbQuery.message as Message.TextMessage)?.text || '';
            const cleanText = messageText.replace(/\n\n[✅🔓] \*\*状态：.*\*\*$/, '');
            const updatedText = cleanText + '\n\n✅ **状态：已解决**';

            try {
                await ctx.editMessageText(updatedText, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ 标记已解决', callback_data: `resolve:${conversationId}:${accountId}` },
                                { text: '🔓 重新打开', callback_data: `reopen:${conversationId}:${accountId}` },
                            ],
                            [
                                { text: '📱 在 Chatwoot 中查看', url: `${config.chatwootBaseUrl}/app/accounts/${accountId}/conversations/${conversationId}` },
                            ],
                        ],
                    },
                });
            } catch {
                log.debug('Failed to update control panel (content may be identical)');
            }
        } catch (error) {
            log.error('Failed to resolve conversation', { conversationId, ...extractAxiosError(error) });
            await ctx.answerCbQuery('❌ 操作失败，请重试');
        }
        return;
    }

    // Forum mode: reopen conversation
    if (data.startsWith('reopen:')) {
        const parts = data.split(':');
        const conversationId = parseInt(parts[1], 10);
        const accountId = parseInt(parts[2], 10);

        if (!conversationId) return;

        try {
            await toggleConversationStatus(conversationId, 'open');
            await ctx.answerCbQuery('🔓 对话已重新打开！');

            const topic = getTopic(conversationId);
            if (topic && config.telegramForumChatId) {
                try {
                    await bot.telegram.reopenForumTopic(config.telegramForumChatId, topic.telegram_topic_id);
                    log.info('Reopened forum topic', { conversationId, topicId: topic.telegram_topic_id });
                } catch {
                    log.debug('Failed to reopen topic (may already be open)');
                }
            }

            const messageText = (cbQuery.message as Message.TextMessage)?.text || '';
            const updatedText = messageText.replace(/\n\n✅ \*\*状态：已解决\*\*$/, '') + '\n\n🔓 **状态：进行中**';

            try {
                await ctx.editMessageText(updatedText, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ 标记已解决', callback_data: `resolve:${conversationId}:${accountId}` },
                                { text: '🔓 重新打开', callback_data: `reopen:${conversationId}:${accountId}` },
                            ],
                            [
                                { text: '📱 在 Chatwoot 中查看', url: `${config.chatwootBaseUrl}/app/accounts/${accountId}/conversations/${conversationId}` },
                            ],
                        ],
                    },
                });
            } catch {
                log.debug('Failed to update control panel (content may be identical)');
            }
        } catch (error) {
            log.error('Failed to reopen conversation', { conversationId, ...extractAxiosError(error) });
            await ctx.answerCbQuery('❌ 操作失败，请重试');
        }
        return;
    }

    // Forum mode: close topic
    if (data.startsWith('close_topic:')) {
        const conversationId = parseInt(data.split(':')[1], 10);
        const topic = getTopic(conversationId);

        if (topic && config.telegramForumChatId) {
            try {
                await bot.telegram.closeForumTopic(config.telegramForumChatId, topic.telegram_topic_id);
                await ctx.answerCbQuery('话题已关闭！🔒');
                log.info('Manually closed topic', { conversationId, topicName: topic.topic_name });
            } catch (error) {
                log.error('Failed to close topic', { conversationId, error: String(error) });
                await ctx.answerCbQuery('关闭话题失败。');
            }
        } else {
            await ctx.answerCbQuery('找不到对应的话题。');
        }
        return;
    }

    // Legacy mode: resolve (no params)
    if (data === 'resolve') {
        const messageId = cbQuery.message?.message_id;
        if (!messageId) return;

        const mapping = getMapping(messageId);
        if (mapping) {
            try {
                await toggleConversationStatus(mapping.chatwoot_conversation_id, 'resolved');
                await ctx.answerCbQuery('会话已解决！✅');
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
                await ctx.reply(`会话 #${mapping.chatwoot_conversation_id} 已标记为已解决。`);
            } catch (error) {
                log.error('Failed to resolve conversation', extractAxiosError(error));
                await ctx.answerCbQuery('解决失败。');
            }
        } else {
            await ctx.answerCbQuery('消息已过期或未知。');
        }
        return;
    }
});

// ============ Media Message Handlers ============

async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; filePath: string }> {
    log.debug('Downloading Telegram file', { fileId });
    const file = await bot.telegram.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) throw new Error('无法获取文件路径');

    const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${filePath}`;
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`下载文件失败: ${response.status} ${response.statusText}`);

    const arrayBuffer = await response.arrayBuffer();
    log.debug('Telegram file downloaded', { fileId, filePath, sizeBytes: arrayBuffer.byteLength });
    return { buffer: Buffer.from(arrayBuffer), filePath };
}

async function handleMediaMessage(
    ctx: Context,
    fileId: string,
    filename: string,
    mimeType: string | undefined,
    caption?: string,
) {
    const conversationId = resolveConversationId(ctx);
    if (!conversationId) {
        if (!isFromForum(ctx) && isAdmin(ctx) && !(ctx.message as Message & { reply_to_message?: Message })?.reply_to_message) {
            await ctx.reply('请回复客户消息来发送附件。');
        }
        return;
    }

    log.debug('Processing media message', { conversationId, filename, mimeType, fileId });

    try {
        void toggleTypingStatus(conversationId, 'on');
        const { buffer, filePath } = await downloadTelegramFile(fileId);
        const finalFilename = filename || filePath.split('/').pop() || `file_${Date.now()}`;

        await createMessageWithAttachment(conversationId, caption || '', {
            buffer,
            filename: finalFilename,
            mimeType,
        });
        // ✅ React to confirm successful attachment delivery
        const msg = ctx.message as Message;
        await setMessageReaction(ctx.chat!.id, msg.message_id, '✅');
        log.info('Attachment sent to Chatwoot', { conversationId, filename: finalFilename });
    } catch (error) {
        log.error('Failed to send attachment to Chatwoot', { conversationId, filename, ...extractAxiosError(error) });
        const msg = ctx.message as Message;
        await setMessageReaction(ctx.chat!.id, msg.message_id, '❌');
        await ctx.reply('❌ 发送附件到 Chatwoot 失败，请查看日志。');
    }
}

bot.on('photo', async (ctx) => {
    const msg = ctx.message as PhotoMessage;
    const photos = msg.photo;
    const photo = photos[photos.length - 1];
    await handleMediaMessage(ctx, photo.file_id, `photo_${Date.now()}.jpg`, 'image/jpeg', msg.caption || '');
});

bot.on('document', async (ctx) => {
    const msg = ctx.message as DocumentMessage;
    const doc = msg.document;
    await handleMediaMessage(ctx, doc.file_id, doc.file_name || `document_${Date.now()}`, doc.mime_type, msg.caption || '');
});

bot.on('video', async (ctx) => {
    const msg = ctx.message as VideoMessage;
    const video = msg.video;
    await handleMediaMessage(ctx, video.file_id, video.file_name || `video_${Date.now()}.mp4`, video.mime_type || 'video/mp4', msg.caption || '');
});

bot.on('audio', async (ctx) => {
    const msg = ctx.message as AudioMessage;
    const audio = msg.audio;
    await handleMediaMessage(ctx, audio.file_id, audio.file_name || `audio_${Date.now()}.mp3`, audio.mime_type || 'audio/mpeg', msg.caption || '');
});

bot.on('voice', async (ctx) => {
    const msg = ctx.message as VoiceMessage;
    await handleMediaMessage(ctx, msg.voice.file_id, `voice_${Date.now()}.ogg`, msg.voice.mime_type || 'audio/ogg', '');
});

bot.on('video_note', async (ctx) => {
    const msg = ctx.message as VideoNoteMessage;
    await handleMediaMessage(ctx, msg.video_note.file_id, `video_note_${Date.now()}.mp4`, 'video/mp4', '');
});

bot.on('sticker', async (ctx) => {
    const msg = ctx.message as StickerMessage;
    const sticker = msg.sticker;
    const isAnimated = sticker.is_animated || sticker.is_video;
    const ext = isAnimated ? 'webm' : 'webp';
    const mimeType = isAnimated ? 'video/webm' : 'image/webp';
    await handleMediaMessage(ctx, sticker.file_id, `sticker_${Date.now()}.${ext}`, mimeType, sticker.emoji || '');
});

bot.on('animation', async (ctx) => {
    const msg = ctx.message as AnimationMessage;
    const anim = msg.animation;
    await handleMediaMessage(ctx, anim.file_id, anim.file_name || `animation_${Date.now()}.mp4`, anim.mime_type || 'video/mp4', msg.caption || '');
});
