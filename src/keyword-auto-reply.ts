export interface KeywordAutoReply {
    keywords: string[];
    reply: string;
}

function splitKeywords(values: string[]): string[] {
    return values
        .flatMap(value => value.split('|'))
        .map(keyword => keyword.trim())
        .filter(Boolean);
}

export function parseKeywordAutoReplies(value: string | undefined): KeywordAutoReply[] {
    if (!value?.trim()) return [];

    const parsed: unknown = JSON.parse(value);

    // 兼容原有简单格式：{"关键词":"回复"}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.entries(parsed)
            .map(([keyword, reply]) => ({
                keywords: splitKeywords([keyword]),
                reply: typeof reply === 'string' ? reply.trim() : '',
            }))
            .filter(({ keywords, reply }) => keywords.length > 0 && reply.length > 0);
    }

    if (!Array.isArray(parsed)) {
        throw new Error('KEYWORD_AUTO_REPLIES must be a JSON object or array');
    }

    return parsed
        .map((item): KeywordAutoReply => {
            if (!item || typeof item !== 'object') return { keywords: [], reply: '' };
            const rule = item as { keywords?: unknown; reply?: unknown };
            const keywords = Array.isArray(rule.keywords)
                ? splitKeywords(rule.keywords.filter((keyword): keyword is string => typeof keyword === 'string'))
                : [];
            return {
                keywords,
                reply: typeof rule.reply === 'string' ? rule.reply.trim() : '',
            };
        })
        .filter(({ keywords, reply }) => keywords.length > 0 && reply.length > 0);
}

export function findKeywordAutoReply(
    content: string,
    replies: KeywordAutoReply[],
): KeywordAutoReply | undefined {
    const normalizedContent = content.toLocaleLowerCase();
    return replies.find(({ keywords }) =>
        keywords.some(keyword => normalizedContent.includes(keyword.toLocaleLowerCase()))
    );
}
