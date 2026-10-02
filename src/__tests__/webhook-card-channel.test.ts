import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

// config 在 import 时校验环境变量，必须先准备
process.env.TELEGRAM_TOKEN = 'test-token';
process.env.TELEGRAM_ADMIN_ID = '111';
process.env.TELEGRAM_FORUM_CHAT_ID = '-100123';
process.env.CHATWOOT_ACCESS_TOKEN = 'test-token';
process.env.CHATWOOT_ACCOUNT_ID = '2';
process.env.CHATWOOT_WEBHOOK_SECRET = 'test-secret';
process.env.KEYWORD_AUTO_REPLIES = '';   // 不触发关键词回复，保持流程单纯
process.env.RAG_ENABLED = 'false';

const mocks = vi.hoisted(() => ({
    sendMessage: vi.fn(async () => ({ message_id: 999 })),
    createForumTopic: vi.fn(async () => ({ message_thread_id: 55 })),
}));

vi.mock('../bot-instance', () => ({
    bot: {
        telegram: {
            sendMessage: mocks.sendMessage,
            createForumTopic: mocks.createForumTopic,
            sendPhoto: vi.fn(),
            sendDocument: vi.fn(),
            sendVideo: vi.fn(),
            sendAudio: vi.fn(),
            setMessageReaction: vi.fn(),
            editMessageText: vi.fn(),
            answerCbQuery: vi.fn(),
        },
    },
}));

vi.mock('../database', () => ({
    initDb: vi.fn(),
    closeDb: vi.fn(),
    saveMapping: vi.fn(),
    getMapping: vi.fn(),
    saveTopic: vi.fn(),
    getTopic: vi.fn(() => undefined),
    getTopicByTopicId: vi.fn(),
    deleteTopic: vi.fn(),
    savePollState: vi.fn(),
    getPollState: vi.fn(),
}));

let apiServer: http.Server;   // 假 Chatwoot API
let botServer: http.Server;   // 被测的真实 express 应用

beforeAll(async () => {
    apiServer = http.createServer((req, res) => {
        if ((req.url || '').includes('/inboxes')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                payload: [{ id: 1, name: '路飞云', channel_type: 'Channel::WebWidget' }],
            }));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>(resolve => apiServer.listen(0, '127.0.0.1', resolve));
    process.env.CHATWOOT_BASE_URL = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;

    const { app } = await import('../server');
    botServer = http.createServer(app);
    await new Promise<void>(resolve => botServer.listen(0, '127.0.0.1', resolve));
});

afterAll(() => {
    botServer?.close();
    apiServer?.close();
});

/** 复现生产载荷：inbox 段只有 {id, name}，conversation 里没有 channel */
const payload = {
    event: 'message_created',
    id: 12345,
    message_type: 'incoming',
    content: '你好',
    account: { id: 2, name: '测试账号' },
    inbox: { id: 1, name: '路飞云' },
    sender: { id: 5, name: '客户', type: 'contact' },
    conversation: { id: 8, inbox_id: 1, additional_attributes: {} },
};

describe('webhook → 卡片渠道（端到端）', () => {
    it('载荷缺 channel 时，端口卡片经收件箱兜底显示正确渠道', async () => {
        const raw = JSON.stringify(payload);
        const signature = crypto.createHmac('sha256', 'test-secret').update(raw).digest('hex');
        const port = (botServer.address() as AddressInfo).port;

        const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-chatwoot-signature': `sha256=${signature}`,
            },
            body: raw,
        });
        expect(response.status).toBe(200);

        // 响应后处理是异步的，轮询等卡片发出
        for (let i = 0; i < 60 && mocks.sendMessage.mock.calls.length === 0; i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        const texts = mocks.sendMessage.mock.calls.map(call => String(call[1] ?? ''));
        const cardText = texts.find(text => text.includes('📥')) ?? '';

        expect(cardText).not.toBe('');
        expect(cardText).toContain('🌐 网页咨询');
        expect(cardText).toContain('· 路飞云');
        expect(cardText).not.toContain('未知渠道');
    });
});
