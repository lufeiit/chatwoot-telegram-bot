import type { Context } from 'telegraf';
import type { CannedResponse } from './types';

const CANNED_PAGE_SIZE = 8;

export function buildCannedKeyboard(responses: Array<Pick<CannedResponse, 'id' | 'short_code'>>, page: number, conversationId: number) {
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

export async function sendCannedResponsePage(ctx: Context, responses: CannedResponse[], page: number, conversationId: number) {
    const keyboard = buildCannedKeyboard(responses, page, conversationId);
    const text = `📋 <b>预设回复</b>（共 ${responses.length} 条）\n选择要发送的回复：`;
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}
