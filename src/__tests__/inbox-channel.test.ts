import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import type { ChatwootMessageEvent } from '../types';

// config 在 import 时会读取并校验环境变量，必须先准备好
process.env.TELEGRAM_TOKEN = 'test-token';
process.env.TELEGRAM_ADMIN_ID = '1';
process.env.CHATWOOT_ACCESS_TOKEN = 'test-token';
process.env.CHATWOOT_ACCOUNT_ID = '2';
process.env.KEYWORD_AUTO_REPLIES = '';

const INBOXES = [
    { id: 1, name: '路飞云', channel_type: 'Channel::WebWidget' },
    { id: 2, name: '迷途云', channel_type: 'Channel::WebWidget' },
];

let requests: string[] = [];
let failMode = false;
let server: http.Server;

type ChatwootModule = typeof import('../chatwoot');
type FormattersModule = typeof import('../formatters');
let cw: ChatwootModule;
let fmt: FormattersModule;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        requests.push(req.url || '');
        if (failMode) {
            // 用 404（4xx）让 withRetry 快速失败，不触发指数退避重试
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'boom' }));
            return;
        }
        if ((req.url || '').includes('/inboxes')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ payload: INBOXES }));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.CHATWOOT_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    cw = await import('../chatwoot');
    fmt = await import('../formatters');
});

afterAll(() => {
    server?.close();
});

/** 复现生产场景：webhook 载荷的 inbox 段只有 {id, name}，且 conversation 里没有 channel */
function eventWithoutChannel(): ChatwootMessageEvent {
    return {
        id: 100,
        event: 'message_created',
        message_type: 'incoming',
        content: '你好',
        inbox: { id: 1, name: '路飞云' },
        sender: { id: 5, name: '客户', type: 'contact' },
        conversation: { id: 8, inbox_id: 1, additional_attributes: {} },
    } as unknown as ChatwootMessageEvent;
}

describe('收件箱渠道兜底', () => {
    it('先复现症状：载荷缺 channel 时卡片显示「未知渠道」', () => {
        const card = fmt.extractContactCard(eventWithoutChannel());
        expect(card.channel).toBeUndefined();
        expect(card.inboxName).toBe('路飞云');
        const text = fmt.renderContactCard(card, 8);
        expect(text).toContain('📥 未知渠道 · 路飞云');
    });

    it('修复后：用收件箱 API 补齐，卡片显示「🌐 网页咨询 · 路飞云」', async () => {
        const card = fmt.extractContactCard(eventWithoutChannel());
        const inbox = await cw.getInboxById(1);
        expect(inbox?.channel_type).toBe('Channel::WebWidget');

        fmt.enrichChannelFromInbox(card, inbox);
        const text = fmt.renderContactCard(card, 8);
        expect(text).toContain('📥 🌐 网页咨询 · 路飞云');
        expect(text).not.toContain('未知渠道');
    });

    it('按 ID 取收件箱走缓存：第二次不再请求', async () => {
        const before = requests.length;
        const inbox = await cw.getInboxById(2);
        expect(inbox?.name).toBe('迷途云');
        expect(requests.length).toBe(before);
    });

    it('查不到的 ID 返回 undefined（调用方保持原样降级）', async () => {
        await expect(cw.getInboxById(999)).resolves.toBeUndefined();
        await expect(cw.getInboxById(undefined)).resolves.toBeUndefined();
    });

    it('接口异常时 getInboxById 不抛错（用缓存兜底）', async () => {
        failMode = true;
        await expect(cw.listInboxes(true)).rejects.toBeTruthy();
        await expect(cw.getInboxById(1)).resolves.toMatchObject({ id: 1 });
        failMode = false;
    });
});

describe('enrichChannelFromInbox（纯函数语义）', () => {
    const base = () => ({ name: '客户', channel: undefined as string | undefined, inboxName: undefined as string | undefined });

    it('只填空缺字段，不覆盖已有值', () => {
        const info = { name: '客户', channel: 'Channel::Api', inboxName: '已有名称' };
        fmt.enrichChannelFromInbox(info, { name: '路飞云', channel_type: 'Channel::WebWidget' });
        expect(info.channel).toBe('Channel::Api');
        expect(info.inboxName).toBe('已有名称');
    });

    it('inbox 为空时原样返回', () => {
        const info = base();
        expect(fmt.enrichChannelFromInbox(info, undefined)).toBe(info);
        expect(info.channel).toBeUndefined();
        expect(info.inboxName).toBeUndefined();
    });
});
