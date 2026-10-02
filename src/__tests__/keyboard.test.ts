import { beforeAll, describe, expect, it, vi } from 'vitest';

// config 加载时会校验必需环境变量，必须在 import 之前准备
process.env.TELEGRAM_TOKEN = 'test-token';
process.env.TELEGRAM_ADMIN_ID = '1';
process.env.CHATWOOT_ACCESS_TOKEN = 'test-token';
process.env.CHATWOOT_ACCOUNT_ID = '2';
process.env.CHATWOOT_BASE_URL = 'https://cw.example.com';

// 避免真连 Telegram / 真建 sqlite 文件
vi.mock('../bot-instance', () => ({ bot: {} }));
vi.mock('../database', () => ({
    saveTopic: vi.fn(),
    getTopic: vi.fn(),
    deleteTopic: vi.fn(),
}));

type TopicsModule = typeof import('../topics');
let mod: TopicsModule;

beforeAll(async () => {
    mod = await import('../topics');
});

describe('内联键盘布局（每行 2 个按钮）', () => {
    it('forum：第一行＝解决/重开，第二行＝查看+刷新（都各 2 个）', () => {
        const { inline_keyboard } = mod.buildForumInlineKeyboard(8, 2, 99);
        expect(inline_keyboard).toHaveLength(2);
        expect(inline_keyboard[0]).toHaveLength(2);
        expect(inline_keyboard[1]).toHaveLength(2);

        expect(inline_keyboard[0][0].callback_data).toBe('r:8:2:99');
        expect(inline_keyboard[0][1].callback_data).toBe('o:8:2:99');
        expect(inline_keyboard[1][0].text).toBe('📱 在 Chatwoot 中查看');
        expect(inline_keyboard[1][0].url).toBe('https://cw.example.com/app/accounts/2/conversations/8');
        expect(inline_keyboard[1][1]).toMatchObject({
            text: '🔄 刷新客户最新资料',
            callback_data: 'c:99:2:8',
        });
    });

    it('forum：没有 contactId 时第二行只剩「查看」（不残留空占位）', () => {
        const { inline_keyboard } = mod.buildForumInlineKeyboard(8, 2);
        expect(inline_keyboard).toHaveLength(2);
        expect(inline_keyboard[1]).toHaveLength(1);
        expect(inline_keyboard[1][0].text).toBe('📱 在 Chatwoot 中查看');
        // callback_data 末尾不带 contactId 段
        expect(inline_keyboard[0][0].callback_data).toBe('r:8:2');
    });

    it('legacy：解决 + 查看 并成一行', () => {
        const { inline_keyboard } = mod.buildLegacyKeyboard(8, 2);
        expect(inline_keyboard).toHaveLength(1);
        expect(inline_keyboard[0]).toHaveLength(2);
        expect(inline_keyboard[0][0]).toMatchObject({ text: '✅ 标记已解决', callback_data: 'resolve' });
        expect(inline_keyboard[0][1].text).toBe('📱 在 Chatwoot 中查看');
    });
});
