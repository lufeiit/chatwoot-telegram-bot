import { createLogger } from './logger';
import type { ChatwootConversation, ChatwootMessageEvent, ChatwootConversationStatusEvent } from './types';
import type { PollState } from './database';

const log = createLogger('poller');

/**
 * 轮询器外部依赖（全部注入，便于单元测试与复用 webhook 的处理逻辑）。
 */
export interface PollerDeps {
    /** 当前 Chatwoot account id（构造事件时使用） */
    accountId: number;
    /** 拉取最近活跃的会话（按 last_activity_at 倒序，含所有状态） */
    listConversations: () => Promise<ChatwootConversation[]>;
    /** 拉取某会话的消息；after 为增量起点（只返回比它更新的消息） */
    listMessages: (conversationId: number, after?: number) => Promise<ChatwootMessageEvent[]>;
    /** 读取本地断点 */
    getState: (conversationId: number) => PollState | undefined;
    /** 保存本地断点 */
    saveState: (conversationId: number, state: PollState) => void;
    /** 处理消息事件（与 webhook 共用） */
    handleMessage: (event: ChatwootMessageEvent) => Promise<void> | void;
    /** 处理会话状态变更（与 webhook 共用） */
    handleStatusChange: (event: ChatwootConversationStatusEvent) => Promise<void> | void;
    /** 事件去重（可选；both 模式下与 webhook 共享同一去重表） */
    isDuplicate?: (eventType: string, eventId: number | undefined) => boolean;
}

export interface PollerOptions {
    /** 轮询间隔（秒） */
    intervalSeconds: number;
    /** 每轮最多检查的会话数（控制 API 请求量） */
    maxConversations: number;
    /** 首次遇到某会话时是否转发历史消息（默认 false：只记断点，避免刷屏） */
    forwardHistory?: boolean;
    /** 遇 429 时的退避起点（毫秒） */
    backoffBaseMs?: number;
    /** 退避上限（毫秒） */
    backoffMaxMs?: number;
    /** 时钟注入（测试用） */
    now?: () => number;
}

export interface PollResult {
    /** 本轮检查的会话数 */
    conversations: number;
    /** 本轮处理的消息数 */
    messages: number;
    /** 本轮检测到的状态变更数 */
    statusChanges: number;
    /** 本轮是否因退避而跳过 */
    skipped: boolean;
}

const DEFAULT_BACKOFF_BASE_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 15 * 60_000;

/** 从 axios 错误里取出 HTTP 状态码与 Retry-After */
function extractRateLimitInfo(error: unknown): { status?: number; retryAfterMs?: number } {
    const err = error as { response?: { status?: number; headers?: Record<string, unknown> } };
    const status = err?.response?.status;
    const raw = err?.response?.headers?.['retry-after'] ?? err?.response?.headers?.['Retry-After'];
    const seconds = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
    return {
        status,
        retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
    };
}

/**
 * Chatwoot 轮询器：不依赖 Webhook，定期用 API 增量拉取新消息与会话状态变化。
 *
 * 工作方式（每轮）：
 *   1. 拉取最近活跃的会话列表（1 次请求）
 *   2. 对每个会话按本地断点做增量拉取（messages?after=<lastMessageId>）
 *   3. 新消息 → 交给 handleMessage（与 webhook 完全相同的转发逻辑）
 *   4. 会话状态变化 → 交给 handleStatusChange（自动归档/重开话题）
 *   5. 保存新断点（消息 ID / 状态），重启后不丢、天然去重
 */
export class ChatwootPoller {
    private timer?: ReturnType<typeof setTimeout>;
    private running = false;
    private backoffMs = 0;
    private backoffUntil = 0;

    private readonly now: () => number;
    private readonly backoffBaseMs: number;
    private readonly backoffMaxMs: number;

    constructor(
        private readonly deps: PollerDeps,
        private readonly options: PollerOptions,
    ) {
        this.now = options.now ?? (() => Date.now());
        this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
        this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    }

    /** 启动轮询（立即执行一轮，之后按间隔循环） */
    start(): void {
        if (this.running) return;
        this.running = true;
        log.info('Polling mode started', {
            intervalSeconds: this.options.intervalSeconds,
            maxConversations: this.options.maxConversations,
            forwardHistory: !!this.options.forwardHistory,
        });
        this.scheduleNext(0);
    }

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        log.info('Polling mode stopped');
    }

    /** 当前是否处于退避中 */
    isBackingOff(): boolean {
        return this.now() < this.backoffUntil;
    }

    private scheduleNext(delayMs: number): void {
        if (!this.running) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.pollOnce()
                .catch(() => { /* pollOnce 内部已记录日志 */ })
                .finally(() => this.scheduleNext(this.options.intervalSeconds * 1000));
        }, delayMs);
        this.timer.unref?.();
    }

    /** 执行一轮轮询（可单独调用，便于测试与手动触发） */
    async pollOnce(): Promise<PollResult> {
        const result: PollResult = { conversations: 0, messages: 0, statusChanges: 0, skipped: false };

        if (this.isBackingOff()) {
            result.skipped = true;
            log.debug('Polling skipped (in backoff)', { remainingMs: this.backoffUntil - this.now() });
            return result;
        }

        const startedAt = this.now();

        try {
            const conversations = await this.deps.listConversations();
            const targets = conversations
                .filter((conversation): conversation is ChatwootConversation & { id: number } => typeof conversation?.id === 'number')
                .slice(0, this.options.maxConversations);

            for (const conversation of targets) {
                try {
                    await this.pollConversation(conversation, result);
                } catch (error) {
                    // 单个会话失败不影响其他会话；若是限流则直接进入退避
                    const { status, retryAfterMs } = extractRateLimitInfo(error);
                    if (status === 429) {
                        this.applyBackoff(retryAfterMs);
                        throw error;
                    }
                    log.error('Failed to poll conversation', {
                        conversationId: conversation.id,
                        status,
                        error: String(error),
                    });
                }
            }

            this.resetBackoff();
            log.debug('Poll round complete', {
                ...result,
                durationMs: this.now() - startedAt,
            });
            return result;
        } catch (error) {
            const { status, retryAfterMs } = extractRateLimitInfo(error);
            if (status === 429) {
                this.applyBackoff(retryAfterMs);
                log.warn('Chatwoot API rate limited, backing off', {
                    backoffMs: this.backoffMs,
                    retryAfterMs,
                });
            } else {
                log.error('Poll round failed', { status, error: String(error) });
            }
            result.skipped = true;
            return result;
        }
    }

    private async pollConversation(
        conversation: ChatwootConversation & { id: number },
        result: PollResult,
    ): Promise<void> {
        const conversationId = conversation.id;
        const state = this.deps.getState(conversationId);

        result.conversations += 1;

        // ===== 1) 消息增量 =====
        const messages = await this.deps.listMessages(conversationId, state?.lastMessageId || undefined);
        const sorted = messages
            .filter((message): message is ChatwootMessageEvent & { id: number } => typeof message?.id === 'number')
            .sort((a, b) => a.id - b.id);

        let lastMessageId = state?.lastMessageId ?? 0;
        const highestKnownId = sorted.reduce((max, message) => Math.max(max, message.id), lastMessageId);

        if (!state && !this.options.forwardHistory) {
            // 首次遇到该会话：只记录断点，不把历史消息全部推到 Telegram
            lastMessageId = highestKnownId;
            log.debug('Conversation baseline recorded (history skipped)', {
                conversationId,
                lastMessageId,
                skipped: sorted.length,
            });
        } else {
            for (const message of sorted) {
                if (message.id <= lastMessageId) continue;
                lastMessageId = message.id;
                // both 模式下与 webhook 共享去重：已处理过的消息不重复转发
                if (this.deps.isDuplicate?.('message_created', message.id)) {
                    log.debug('Skipping already-handled message', { conversationId, messageId: message.id });
                    continue;
                }
                await this.deps.handleMessage(this.buildMessageEvent(message, conversation));
                result.messages += 1;
            }
        }

        // ===== 2) 会话状态变更 =====
        let lastStatus = state?.lastStatus;
        if (conversation.status && state?.lastStatus && conversation.status !== state.lastStatus) {
            lastStatus = conversation.status;
            await this.deps.handleStatusChange({
                event: 'conversation_status_changed',
                id: conversationId,
                status: conversation.status as ChatwootConversationStatusEvent['status'],
                conversation,
            });
            result.statusChanges += 1;
        } else if (conversation.status) {
            lastStatus = conversation.status;
        }

        // ===== 3) 保存断点 =====
        this.deps.saveState(conversationId, { lastMessageId, lastStatus });
    }

    /** 用会话信息补齐消息事件（messages API 只返回消息本身，不带 conversation/account） */
    private buildMessageEvent(message: ChatwootMessageEvent, conversation: ChatwootConversation): ChatwootMessageEvent {
        return {
            ...message,
            event: 'message_created',
            conversation,
            account: { id: conversation.account_id ?? this.deps.accountId },
        };
    }

    private applyBackoff(retryAfterMs?: number): void {
        const next = retryAfterMs ?? Math.min(
            this.backoffMaxMs,
            this.backoffMs > 0 ? this.backoffMs * 2 : this.backoffBaseMs,
        );
        this.backoffMs = Math.min(this.backoffMaxMs, next);
        this.backoffUntil = this.now() + this.backoffMs;
        log.warn('Entering backoff after rate limit', {
            backoffMs: this.backoffMs,
            until: new Date(this.backoffUntil).toISOString(),
        });
    }

    private resetBackoff(): void {
        if (this.backoffMs !== 0) {
            log.info('Rate limit backoff cleared');
            this.backoffMs = 0;
            this.backoffUntil = 0;
        }
    }
}
