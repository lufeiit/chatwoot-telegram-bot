import { describe, expect, it } from 'vitest';
import { ChatwootPoller, type PollerDeps } from '../poller';
import type { PollState } from '../database';
import type { ChatwootConversation, ChatwootMessageEvent } from '../types';

interface HarnessOptions {
    conversations: ChatwootConversation[];
    /** 每个会话的完整消息列表（模拟 API：after 由 listMessages 负责过滤） */
    messages: Record<number, ChatwootMessageEvent[]>;
    states?: Record<number, PollState>;
    forwardHistory?: boolean;
    maxConversations?: number;
    now?: () => number;
    /** 自定义会话列表拉取（默认返回 options.conversations；可抛错用于限流测试） */
    listConversations?: () => Promise<ChatwootConversation[]>;
    /** 让指定会话的 listMessages 抛错（用于单会话失败测试） */
    messagesError?: (conversationId: number) => unknown;
    isDuplicate?: (eventType: string, eventId: number | undefined) => boolean;
}

function setup(options: HarnessOptions) {
    const states: Record<number, PollState> = options.states ?? {};
    const handled: ChatwootMessageEvent[] = [];
    const statusChanges: Array<{ id?: number; status?: string }> = [];
    const apiCalls: Array<{ conversationId: number; after?: number }> = [];

    const deps: PollerDeps = {
        accountId: 1,
        listConversations: options.listConversations ?? (async () => options.conversations),
        listMessages: async (conversationId, after) => {
            apiCalls.push({ conversationId, after });
            const failure = options.messagesError?.(conversationId);
            if (failure) throw failure;
            const all = options.messages[conversationId] ?? [];
            return after == null ? all : all.filter(message => (message.id ?? 0) > after);
        },
        getState: (conversationId) => states[conversationId],
        saveState: (conversationId, state) => { states[conversationId] = state; },
        handleMessage: (event) => { handled.push(event); },
        handleStatusChange: (event) => { statusChanges.push({ id: event.id, status: event.status }); },
        isDuplicate: options.isDuplicate,
    };

    const poller = new ChatwootPoller(deps, {
        intervalSeconds: 10,
        maxConversations: options.maxConversations ?? 10,
        forwardHistory: options.forwardHistory,
        now: options.now,
    });

    return { poller, handled, statusChanges, states, apiCalls };
}

function conversation(id: number, status = 'open'): ChatwootConversation {
    return { id, status, account_id: 1, inbox_id: 3 } as ChatwootConversation;
}

function message(id: number, content = `msg-${id}`): ChatwootMessageEvent {
    return {
        event: 'message_created',
        id,
        content,
        message_type: 'incoming',
        created_at: '2026-10-02T00:00:00Z',
    } as ChatwootMessageEvent;
}

describe('ChatwootPoller', () => {
    it('首次遇到会话时只记录断点，不转发历史消息（默认行为）', async () => {
        const h = setup({ conversations: [conversation(10)], messages: { 10: [message(1), message(2), message(3)] } });

        const result = await h.poller.pollOnce();

        expect(result.messages).toBe(0);
        expect(h.handled).toHaveLength(0);
        expect(h.states[10]?.lastMessageId).toBe(3);
        expect(h.states[10]?.lastStatus).toBe('open');
    });

    it('开启 forwardHistory 时首轮转发历史消息', async () => {
        const h = setup({
            conversations: [conversation(10)],
            messages: { 10: [message(1), message(2)] },
            forwardHistory: true,
        });

        const result = await h.poller.pollOnce();

        expect(result.messages).toBe(2);
        expect(h.handled.map(e => e.id)).toEqual([1, 2]);
    });

    it('增量拉取：只处理比断点更新的消息，并推进断点', async () => {
        const h = setup({
            conversations: [conversation(10)],
            messages: { 10: [message(1), message(2), message(3), message(4)] },
            states: { 10: { lastMessageId: 2, lastStatus: 'open' } },
        });

        const result = await h.poller.pollOnce();

        expect(result.messages).toBe(2);
        expect(h.handled.map(e => e.id)).toEqual([3, 4]);
        expect(h.apiCalls[0]).toEqual({ conversationId: 10, after: 2 });
        expect(h.states[10]?.lastMessageId).toBe(4);
    });

    it('补齐事件上下文（conversation / account）', async () => {
        const h = setup({
            conversations: [conversation(10)],
            messages: { 10: [message(5)] },
            states: { 10: { lastMessageId: 4, lastStatus: 'open' } },
        });

        await h.poller.pollOnce();

        expect(h.handled[0].conversation?.id).toBe(10);
        expect(h.handled[0].conversation?.inbox_id).toBe(3);
        expect(h.handled[0].account?.id).toBe(1);
    });

    it('会话状态变化时触发状态处理，状态未变则不触发', async () => {
        const h = setup({
            conversations: [conversation(10, 'resolved')],
            messages: { 10: [] },
            states: { 10: { lastMessageId: 7, lastStatus: 'open' } },
        });

        const first = await h.poller.pollOnce();
        expect(first.statusChanges).toBe(1);
        expect(h.statusChanges[0]).toMatchObject({ id: 10, status: 'resolved' });
        expect(h.states[10]?.lastStatus).toBe('resolved');

        const second = await h.poller.pollOnce();
        expect(second.statusChanges).toBe(0);
    });

    it('去重：已处理过的消息不重复转发', async () => {
        const h = setup({
            conversations: [conversation(10)],
            messages: { 10: [message(1), message(2)] },
            states: { 10: { lastMessageId: 1, lastStatus: 'open' } },
            isDuplicate: (_type, eventId) => eventId === 2,
        });

        const result = await h.poller.pollOnce();

        expect(result.messages).toBe(0);
        expect(h.handled).toHaveLength(0);
        expect(h.states[10]?.lastMessageId).toBe(2); // 断点仍推进，避免反复检查
    });

    it('受 maxConversations 限制，只检查最近的若干个会话', async () => {
        const h = setup({
            conversations: [conversation(1), conversation(2), conversation(3)],
            messages: { 1: [], 2: [], 3: [] },
            maxConversations: 2,
        });

        const result = await h.poller.pollOnce();

        expect(result.conversations).toBe(2);
        expect(h.apiCalls.map(c => c.conversationId)).toEqual([1, 2]);
    });

    it('单个会话失败不影响其他会话', async () => {
        const h = setup({
            conversations: [conversation(1), conversation(2)],
            messages: { 1: [], 2: [] },
            messagesError: (conversationId) => (conversationId === 1 ? new Error('boom') : undefined),
        });

        const result = await h.poller.pollOnce();

        expect(result.conversations).toBe(2);
        expect(h.states[1]).toBeUndefined();
        expect(h.states[2]).toBeDefined();
    });

    it('遇 429 进入退避（尊重 Retry-After），退避结束后恢复', async () => {
        let currentTime = 1_000_000;
        let attempts = 0;
        const h = setup({
            conversations: [conversation(1)],
            messages: {},
            listConversations: async () => {
                attempts += 1;
                if (attempts === 1) {
                    throw { response: { status: 429, headers: { 'retry-after': '30' } } };
                }
                return [conversation(1)];
            },
            now: () => currentTime,
        });

        const first = await h.poller.pollOnce();
        expect(first.skipped).toBe(true);
        expect(h.poller.isBackingOff()).toBe(true);

        // 退避期内不调用 API
        currentTime += 10_000;
        const second = await h.poller.pollOnce();
        expect(second.skipped).toBe(true);
        expect(attempts).toBe(1);

        // 退避结束：恢复轮询并清除退避
        currentTime += 30_000;
        const third = await h.poller.pollOnce();
        expect(third.skipped).toBe(false);
        expect(attempts).toBe(2);
        expect(h.poller.isBackingOff()).toBe(false);
    });

    it('普通错误不进入退避（下一轮仍会尝试）', async () => {
        const h = setup({
            conversations: [conversation(1)],
            messages: {},
            listConversations: async () => { throw new Error('network down'); },
        });

        const result = await h.poller.pollOnce();

        expect(result.skipped).toBe(true);
        expect(h.poller.isBackingOff()).toBe(false);
    });
});
