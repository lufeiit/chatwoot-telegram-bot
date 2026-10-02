import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// 必须在 import config 之前准备必需环境变量（config 加载时会校验）
process.env.TELEGRAM_TOKEN = 'test-token';
process.env.TELEGRAM_ADMIN_ID = '1';
process.env.CHATWOOT_ACCESS_TOKEN = 'test-token';
process.env.CHATWOOT_ACCOUNT_ID = '1';
process.env.KEYWORD_AUTO_REPLIES = '';
process.env.RAG_TOKEN = 'test-rag-token';
process.env.RAG_INBOX_BRAND = '1:lufei,2:straycloud';

type KnowledgeModule = typeof import('../knowledge');
let mod: KnowledgeModule;

interface Recorded {
    url?: string;
    headers: http.IncomingHttpHeaders;
    body: Record<string, unknown>;
}

let received: Recorded[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let server: http.Server;
let port = 0;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            let body: Record<string, unknown> = {};
            try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
            received.push({ url: req.url, headers: req.headers, body });
            res.writeHead(reply.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(reply.body));
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    process.env.RAG_ENDPOINT = `http://127.0.0.1:${port}`;
    mod = await import('../knowledge');
});

afterAll(() => {
    server.close();
});

describe('askKnowledgeBase', () => {
    it('未启用时直接返回 null，不发请求', async () => {
        delete process.env.RAG_ENABLED;
        const cfg = (await import('../config')).config;
        (cfg as { ragEnabled: boolean }).ragEnabled = false;
        received = [];
        const r = await mod.askKnowledgeBase({ question: '测试', inboxId: 1 });
        expect(r).toBeNull();
        expect(received).toHaveLength(0);
    });

    it('正常响应时解析全部字段，并带上令牌与收件箱', async () => {
        const cfg = (await import('../config')).config;
        (cfg as { ragEnabled: boolean }).ragEnabled = true;
        reply = {
            status: 200,
            body: {
                answer: '请购买【重置流量包】', confidence: 0.72, needs_human: false,
                mode: 'verbatim', reason: '命中历史客服回答，原话直发',
                suggestion: '建议原文', suggestion_src: 'FQA/流量',
            },
        };
        received = [];
        const r = await mod.askKnowledgeBase({ question: '流量用完了怎么办', inboxId: 2 });
        expect(r?.answer).toBe('请购买【重置流量包】');
        expect(r?.confidence).toBeCloseTo(0.72);
        expect(r?.needsHuman).toBe(false);
        expect(r?.mode).toBe('verbatim');
        expect(r?.suggestionSrc).toBe('FQA/流量');
        expect(received[0].headers['x-rag-token']).toBe('test-rag-token');
        expect(received[0].body.inbox_id).toBe(2);
        expect(received[0].body.brand).toBe('straycloud');
        expect(received[0].url).toBe('/answer');
    });

    it('服务端 5xx 时降级返回 null（不抛异常）', async () => {
        reply = { status: 500, body: { error: 'boom' } };
        const r = await mod.askKnowledgeBase({ question: '测试', inboxId: 1 });
        expect(r).toBeNull();
    });

    it('服务端 401 时降级返回 null', async () => {
        reply = { status: 401, body: { error: 'unauthorized' } };
        const r = await mod.askKnowledgeBase({ question: '测试', inboxId: 1 });
        expect(r).toBeNull();
    });

    it('needs_human=true 时原样透传（由调用方决定只写备注）', async () => {
        reply = { status: 200, body: { answer: '', confidence: 0.54, needs_human: true, reason: '实词覆盖率不足' } };
        const r = await mod.askKnowledgeBase({ question: '支持退款吗', inboxId: 1 });
        expect(r?.needsHuman).toBe(true);
        expect(r?.answer).toBe('');
        expect(r?.reason).toBe('实词覆盖率不足');
    });

    it('未映射的收件箱不附带 brand', async () => {
        reply = { status: 200, body: { answer: 'x', confidence: 0.9, needs_human: false } };
        received = [];
        await mod.askKnowledgeBase({ question: '测试', inboxId: 99 });
        expect(received[0].body.brand).toBeUndefined();
    });
});

describe('brandForInbox', () => {
    it('按映射返回品牌', () => {
        expect(mod.brandForInbox(1)).toBe('lufei');
        expect(mod.brandForInbox(2)).toBe('straycloud');
    });

    it('未知或未提供时返回 undefined', () => {
        expect(mod.brandForInbox(42)).toBeUndefined();
        expect(mod.brandForInbox(undefined)).toBeUndefined();
    });
});
