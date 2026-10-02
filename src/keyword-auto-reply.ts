import { load as loadYaml, YAMLException } from 'js-yaml';

export interface KeywordAutoReply {
    keywords: string[];
    reply: string;
    /** 仅对这些收件箱生效（收件箱 ID）；缺省表示对所有收件箱通用 */
    inboxIds?: number[];
}

/** 解析条目上的 inbox 字段：支持单个 ID（3）或数组（[3, 5]），也兼容 inboxes */
function parseInboxIds(value: unknown): number[] | undefined {
    if (value == null || value === '') return undefined;

    const raw = Array.isArray(value) ? value : [value];
    const ids = raw
        .map(item => (typeof item === 'string' ? Number(item.trim()) : item))
        .filter((item): item is number => typeof item === 'number' && Number.isInteger(item));

    return ids.length > 0 ? Array.from(new Set(ids)) : undefined;
}

/**
 * 归一化一组规则，支持两种写法：
 *   1. 数组（推荐）：[{ keywords: "关键词|关键词" | ["关键词"], reply: "回复", inbox?: 3 | [3,5] }]
 *   2. 映射（旧写法，全部视为通用规则）：{ "关键词|关键词": "回复" }
 */
function normalizeEntries(value: unknown): KeywordAutoReply[] {
    if (Array.isArray(value)) {
        return value
            .map((item): KeywordAutoReply => {
                if (!item || typeof item !== 'object') return { keywords: [], reply: '' };
                const rule = item as { keywords?: unknown; reply?: unknown; inbox?: unknown; inboxes?: unknown };
                const rawKeywords = typeof rule.keywords === 'string'
                    ? [rule.keywords]
                    : Array.isArray(rule.keywords)
                        ? rule.keywords.filter((keyword): keyword is string => typeof keyword === 'string')
                        : [];
                return {
                    keywords: splitKeywords(rawKeywords),
                    reply: decodeReply(typeof rule.reply === 'string' ? rule.reply : ''),
                    inboxIds: parseInboxIds(rule.inbox ?? rule.inboxes),
                };
            })
            .filter(({ keywords, reply }) => keywords.length > 0 && reply.length > 0);
    }

    if (value && typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>)
            .map(([keyword, reply]) => ({
                keywords: splitKeywords([keyword]),
                reply: decodeReply(typeof reply === 'string' ? reply : ''),
            }))
            .filter(({ keywords, reply }) => keywords.length > 0 && reply.length > 0);
    }

    if (value == null) return [];
    throw new Error('规则必须是规则数组（条目可带 inbox）或「关键词 -> 回复」映射');
}

function splitKeywords(values: string[]): string[] {
    return values
        .flatMap(value => value.split('|'))
        .map(keyword => keyword.trim())
        .filter(Boolean);
}

/**
 * 处理回复文本的换行写法：
 *   · 含字面 `\n`（写在 YAML 块标量里）→ `\n` 表示换行，其余真实换行只是排版折行，会被忽略
 *     （便于把长回复分成多行书写，既好读又不会把配置撑高）
 *   · 不含字面 `\n` → 保持原样（双引号写法里的 `\n` 已由 YAML 转义，多行块的真实换行也保持）
 */
function decodeReply(raw: string): string {
    if (!raw.includes('\\n')) return raw.trim();

    return raw
        .replace(/\\n/g, '\u0000')      // 字面 \n 暂存
        .replace(/[\r\n]+/g, '')        // 只去掉真实换行（排版折行），不动空格
        .replace(/\u0000/g, '\n')       // 还原为真正的换行
        .trim();
}

/** 解析 YAML；空白文档（含仅有注释）在部分实现中会报错，统一按“无内容”处理 */
function loadYamlDocument(contents: string): unknown {
    try {
        return loadYaml(contents);
    } catch (error) {
        if (error instanceof YAMLException && /empty/i.test(error.message)) return null;
        throw error;
    }
}

/**
 * 解析 KEYWORD_AUTO_REPLIES（.env 中用单引号包裹；兼容旧的单行 JSON）：
 *
 * 推荐写法：块标量排版 + 用 `\n` 控制换行（长回复可分多行书写，好读又不会把配置撑高）
 *
 *   - keywords: 人工 | 客服
 *     reply: |
 *       请等待客服...........\n\n\n
 *       或者请在群组内联系管理员\n\n\n
 *       人工客服工作时段：9:00 - 21:00
 *
 *   - keywords: 价格
 *     inbox: 3
 *     reply: A 站价格请看：https://example.com/a-pricing
 *
 * 其他写法：
 *   · 双引号 + `\n`（单行）：reply: "第一行\n\n第二行"
 *   · 多行原文（真实换行生效）：reply: | 后直接写多行，不写 `\n`
 *   · 旧 JSON：{"关键词":"回复"} 或 [{"keywords":[...],"reply":"..."}]
 *
 * 匹配按书写顺序：第一条「适用于当前收件箱且关键词命中」的规则生效。
 */
export function parseKeywordAutoReplyList(value: string | undefined): KeywordAutoReply[] {
    if (!value?.trim()) return [];

    const parsed: unknown = loadYamlDocument(value);
    if (parsed == null) return [];

    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
        const doc = parsed as Record<string, unknown>;
        if ('default' in doc || 'inboxes' in doc) {
            throw new Error('已不再支持 default / inboxes 分组写法：请改为单列表，并在需要差异化的条目上写 inbox（参考 .env.example）');
        }
    }

    return normalizeEntries(parsed);
}

/**
 * 按收件箱选择回复：
 *   · 规则未标 inbox → 对所有收件箱生效
 *   · 规则标了 inbox → 仅当消息来自这些收件箱时生效
 *   · 按书写顺序，取第一条命中的规则
 */
export function findKeywordAutoReplyForInbox(
    content: string,
    replies: KeywordAutoReply[],
    inboxId?: number,
): KeywordAutoReply | undefined {
    const normalizedContent = content.toLocaleLowerCase();
    return replies.find(({ keywords, inboxIds }) => {
        if (inboxIds?.length && (inboxId == null || !inboxIds.includes(inboxId))) return false;
        return keywords.some(keyword => normalizedContent.includes(keyword.toLocaleLowerCase()));
    });
}
