import axios from 'axios';
import http from 'http';
import https from 'https';
import FormData from 'form-data';
import { config } from './config';
import { createLogger } from './logger';
import type { CannedResponse } from './types';

const log = createLogger('chatwoot');

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const client = axios.create({
    baseURL: config.chatwootBaseUrl,
    timeout: 15_000,
    httpAgent,
    httpsAgent,
    headers: {
        'api_access_token': config.chatwootAccessToken,
        'Content-Type': 'application/json',
    },
});

const uploadClient = axios.create({
    baseURL: config.chatwootBaseUrl,
    timeout: 60_000,
    httpAgent,
    httpsAgent,
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
});

// ============ Retry with Exponential Backoff ============

async function withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 3, baseDelay = 1000): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error: unknown) {
            lastError = error;
            if (attempt === maxRetries) break;

            const axErr = error as { response?: { status?: number } };
            const status = axErr?.response?.status;
            if (status && status >= 400 && status < 500 && status !== 429) break;

            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
            log.warn(`${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms`, { status });
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
}

// ============ Outgoing Message Loop Prevention ============

const SENT_ID_TTL_MS = 120_000;
const recentlySentIds = new Map<number, number>();

const sentIdCleanupTimer = setInterval(() => {
    const cutoff = Date.now() - SENT_ID_TTL_MS;
    for (const [id, ts] of recentlySentIds) {
        if (ts < cutoff) recentlySentIds.delete(id);
    }
}, SENT_ID_TTL_MS);
sentIdCleanupTimer.unref();

function trackSentMessage(chatwootMessageId: number) {
    recentlySentIds.set(chatwootMessageId, Date.now());
}

export function isSelfSentMessage(chatwootMessageId: number | undefined): boolean {
    if (!chatwootMessageId) return false;
    return recentlySentIds.has(chatwootMessageId);
}

// ============ Messages ============

export async function createMessage(conversationId: number, content: string) {
    return withRetry(async () => {
        const accountId = config.chatwootAccountId;
        const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
        const response = await client.post(url, {
            content,
            message_type: 'outgoing',
            private: false,
        });
        if (response.data?.id) trackSentMessage(response.data.id);
        return response.data;
    }, `createMessage(conv=${conversationId})`);
}

export async function createPrivateNote(conversationId: number, content: string) {
    return withRetry(async () => {
        const accountId = config.chatwootAccountId;
        const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
        const response = await client.post(url, {
            content,
            message_type: 'outgoing',
            private: true,
        });
        if (response.data?.id) trackSentMessage(response.data.id);
        return response.data;
    }, `createPrivateNote(conv=${conversationId})`);
}

export async function createMessageWithAttachment(
    conversationId: number,
    content: string,
    attachment: { buffer: Buffer; filename: string; mimeType?: string }
) {
    return withRetry(async () => {
        const accountId = config.chatwootAccountId;
        const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;

        const formData = new FormData();
        formData.append('content', content || '');
        formData.append('message_type', 'outgoing');
        formData.append('private', 'false');
        formData.append('attachments[]', attachment.buffer, {
            filename: attachment.filename,
            contentType: attachment.mimeType || 'application/octet-stream',
        });

        const response = await uploadClient.post(url, formData, {
            headers: {
                ...formData.getHeaders(),
                'api_access_token': config.chatwootAccessToken,
            },
        });
        if (response.data?.id) trackSentMessage(response.data.id);
        return response.data;
    }, `createMessageWithAttachment(conv=${conversationId})`);
}

// ============ Conversation Status ============

export async function toggleConversationStatus(conversationId: number, status: 'open' | 'resolved') {
    return withRetry(async () => {
        const accountId = config.chatwootAccountId;
        const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`;
        const response = await client.post(url, { status });
        return response.data;
    }, `toggleStatus(conv=${conversationId}, status=${status})`);
}

// ============ Typing Status ============

export async function toggleTypingStatus(conversationId: number, typingStatus: 'on' | 'off') {
    try {
        const accountId = config.chatwootAccountId;
        const url = `/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_typing_status`;
        await client.post(url, { typing_status: typingStatus });
    } catch (error) {
        log.debug('Failed to toggle typing status (non-critical)', { conversationId, typingStatus });
    }
}

// ============ Canned Responses (with short-lived cache) ============

const CANNED_CACHE_TTL_MS = 30_000;
let cannedCache: { data: CannedResponse[]; key: string; ts: number } | null = null;

export async function getCannedResponses(search?: string): Promise<CannedResponse[]> {
    const cacheKey = search || '__all__';
    if (cannedCache && cannedCache.key === cacheKey && Date.now() - cannedCache.ts < CANNED_CACHE_TTL_MS) {
        return cannedCache.data;
    }

    const data = await withRetry(async () => {
        const accountId = config.chatwootAccountId;
        const url = `/api/v1/accounts/${accountId}/canned_responses`;
        const params: Record<string, string> = {};
        if (search) params.search = search;
        const response = await client.get(url, { params });
        return response.data as CannedResponse[];
    }, 'getCannedResponses');

    cannedCache = { data, key: cacheKey, ts: Date.now() };
    return data;
}
