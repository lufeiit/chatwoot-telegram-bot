import axios from 'axios';
import { config } from './config';
import { createLogger, extractAxiosError } from './logger';

const log = createLogger('knowledge');

/** 本地知识库（rag-api）返回结构 */
export interface KnowledgeAnswer {
    /** 可直接外发给客户的答案（已被服务端的事实校验放行） */
    answer: string;
    confidence: number;
    needsHuman: boolean;
    mode?: 'verbatim' | 'generated';
    reason?: string;
    /** Top-1 命中的原文（供客服参考，不自动外发） */
    suggestion?: string;
    suggestionSrc?: string;
    latencyMs?: number;
}

/**
 * 询问本地知识库。
 * 任何异常都返回 null（降级：不影响关键词回复与 Telegram 转发），由调用方决定后续动作。
 */
export async function askKnowledgeBase(params: {
    question: string;
    inboxId?: number;
}): Promise<KnowledgeAnswer | null> {
    if (!config.ragEnabled) return null;
    if (!config.ragEndpoint) {
        log.warn('RAG_ENABLED=true 但未配置 RAG_ENDPOINT，跳过知识库');
        return null;
    }

    const url = `${config.ragEndpoint.replace(/\/+$/, '')}/answer`;
    const brand = brandForInbox(params.inboxId);
    const startedAt = Date.now();

    try {
        const { data } = await axios.post(
            url,
            { question: params.question, inbox_id: params.inboxId, brand },
            {
                timeout: config.ragTimeoutMs,
                headers: {
                    'Content-Type': 'application/json',
                    ...(config.ragToken ? { 'X-RAG-Token': config.ragToken } : {}),
                },
            },
        );

        const result: KnowledgeAnswer = {
            answer: typeof data?.answer === 'string' ? data.answer : '',
            confidence: Number(data?.confidence ?? 0),
            needsHuman: Boolean(data?.needs_human),
            mode: data?.mode,
            reason: data?.reason,
            suggestion: typeof data?.suggestion === 'string' ? data.suggestion : '',
            suggestionSrc: typeof data?.suggestion_src === 'string' ? data.suggestion_src : '',
            latencyMs: Date.now() - startedAt,
        };
        log.info('知识库返回', {
            inboxId: params.inboxId,
            brand,
            confidence: Number(result.confidence.toFixed(3)),
            mode: result.mode,
            needsHuman: result.needsHuman,
            answerLength: result.answer.length,
            latencyMs: result.latencyMs,
        });
        return result;
    } catch (error) {
        log.warn('知识库调用失败，已降级（不回复客户）', {
            inboxId: params.inboxId,
            ...extractAxiosError(error),
        });
        return null;
    }
}

/** 收件箱 → 品牌（用于知识库按品牌隔离检索）。未配置则返回 undefined，由服务端兜底。 */
export function brandForInbox(inboxId?: number): string | undefined {
    if (inboxId == null) return undefined;
    return config.ragInboxBrand[String(inboxId)];
}
