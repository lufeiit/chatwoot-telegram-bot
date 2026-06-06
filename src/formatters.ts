import type {
    ChatwootMessageEvent,
    ContactCardInfo,
    ChatwootSender,
    ChatwootContactDetail,
    ChatwootConversation,
    CustomAttributeDefinition,
    CustomAttributeType,
    ChatwootAdditionalAttributes,
    ChatwootBrowserInfo,
} from './types';

// ============ HTML Escaping ============

/**
 * Telegram HTML parse_mode 转义。
 * 只需转义这三个字符：& < >
 * https://core.telegram.org/bots/api#html-style
 */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** 安全包成 <b>…</b> */
export function bold(text: string): string {
    return `<b>${escapeHtml(text)}</b>`;
}

/** 安全包成 <i>…</i> */
export function italic(text: string): string {
    return `<i>${escapeHtml(text)}</i>`;
}

/** 安全的可点击链接 */
export function link(text: string, url: string): string {
    // URL 中包含 & 时也需转义为 &amp;
    return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
}

// ============ Markdown → Telegram HTML ============

/**
 * 把 Chatwoot 中常见的 Markdown 子集转换成 Telegram 支持的 HTML 标签。
 *
 * Telegram HTML 支持的标签（已涵盖）：
 *   <b> <i> <u> <s> <code> <pre> <a> <blockquote>
 *
 * 处理顺序很关键：先用占位符保护代码块和链接，再处理 bold/italic/strike，
 * 最后还原占位符。避免代码块/链接里的 `*` `_` 被误当作 Markdown 语法。
 */
export function markdownToTelegramHtml(md: string): string {
    if (!md) return '';

    // 先 HTML escape 一次。后续插入的标签是直接拼接，不会被二次 escape。
    let text = escapeHtml(md);

    // 1. 围栏代码块 ```lang?\n...\n``` —— 用占位符保护，内容不再二次处理
    const codeBlocks: string[] = [];
    text = text.replace(/```(?:[a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, (_match, code: string) => {
        const idx = codeBlocks.length;
        codeBlocks.push(`<pre>${code.replace(/\n+$/, '')}</pre>`);
        return ` __CB${idx}__ `;
    });

    // 2. 行内代码 `code`
    const inlineCodes: string[] = [];
    text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
        const idx = inlineCodes.length;
        inlineCodes.push(`<code>${code}</code>`);
        return ` __IC${idx}__ `;
    });

    // 3. 链接 [text](url) —— 整段也用占位符保护，避免 URL 里的 * _ 被后续误处理
    //    （escapeHtml 已把 url 中的 & 转成 &amp;，可直接拼入 href）
    const links: string[] = [];
    text = text.replace(/\[([^\]\n]+)\]\(([^)\n\s]+)\)/g, (_match, linkText: string, url: string) => {
        const idx = links.length;
        links.push(`<a href="${url}">${linkText}</a>`);
        return ` __LK${idx}__ `;
    });

    // 4. 加粗 **text** （在斜体之前；不允许跨行；非贪婪）
    text = text.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, '<b>$1</b>');

    // 5. 斜体 *text*（避免 ** 残留被误吃）和 _text_（要求两侧不是单词字符，避免 snake_case 误伤）
    text = text.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
    text = text.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1<i>$2</i>');

    // 6. 删除线 ~~text~~
    text = text.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');

    // 7. 按相反顺序还原占位符
    text = text.replace(/ __LK(\d+)__ /g, (_m, i: string) => links[Number(i)] ?? '');
    text = text.replace(/ __IC(\d+)__ /g, (_m, i: string) => inlineCodes[Number(i)] ?? '');
    text = text.replace(/ __CB(\d+)__ /g, (_m, i: string) => codeBlocks[Number(i)] ?? '');

    return text;
}

// ============ Channel / Language / Referer Labels ============

const CHANNEL_LABEL: Record<string, string> = {
    'Channel::WebWidget': '🌐 网页咨询',
    'Channel::Api': '🔌 API',
    'Channel::Email': '📧 邮件',
    'Channel::FacebookPage': '📘 Facebook',
    'Channel::TwitterProfile': '🐦 Twitter',
    'Channel::TwilioSms': '📱 短信',
    'Channel::Whatsapp': '💚 WhatsApp',
    'Channel::Sms': '📱 短信',
    'Channel::Telegram': '✈️ Telegram',
    'Channel::Line': '💬 LINE',
    'Channel::Instagram': '📸 Instagram',
    'Channel::Voice': '📞 语音',
};

function channelLabel(channel?: string): string {
    if (!channel) return '未知渠道';
    return CHANNEL_LABEL[channel] || channel.replace(/^Channel::/, '');
}

/**
 * 把 BCP47/ISO-639-1 语言码翻译成中文显示名。
 * 与 Chatwoot UI 一致：Chatwoot 把 "zh" → "Chinese"，我们更进一步翻成中文。
 * 未识别的代码原样返回。
 */
const LANG_LABEL: Record<string, string> = {
    zh: '中文',
    'zh-cn': '简体中文',
    'zh-tw': '繁体中文',
    'zh-hk': '繁体中文（香港）',
    en: '英文',
    'en-us': '英文（美）',
    'en-gb': '英文（英）',
    ja: '日文',
    ko: '韩文',
    ru: '俄文',
    fr: '法文',
    de: '德文',
    es: '西班牙文',
    'es-es': '西班牙文',
    pt: '葡萄牙文',
    'pt-br': '葡萄牙文（巴西）',
    it: '意大利文',
    ar: '阿拉伯文',
    vi: '越南文',
    th: '泰文',
    id: '印尼文',
    tr: '土耳其文',
    hi: '印地文',
    nl: '荷兰文',
    pl: '波兰文',
    sv: '瑞典文',
    fi: '芬兰文',
    da: '丹麦文',
    no: '挪威文',
    uk: '乌克兰文',
    he: '希伯来文',
    cs: '捷克文',
    el: '希腊文',
    ro: '罗马尼亚文',
    hu: '匈牙利文',
    bg: '保加利亚文',
    fa: '波斯文',
    bn: '孟加拉文',
    ms: '马来文',
    fil: '菲律宾文',
    mn: '蒙古文',
};

export function languageLabel(code: string | undefined | null): string {
    if (!code) return '';
    // 归一化：转小写、把下划线变连字符（zh_CN → zh-cn）
    const norm = String(code).trim().toLowerCase().replace(/_/g, '-');
    if (LANG_LABEL[norm]) return LANG_LABEL[norm];
    // 退到主语言：zh-cn → zh
    const primary = norm.split('-')[0];
    if (LANG_LABEL[primary]) return LANG_LABEL[primary];
    return String(code);
}

/**
 * 把 referer URL 渲染成可点击链接，锚文本只显示 hostname（更短更整洁）。
 * URL 解析失败时回退到完整 URL 当锚文本。
 * 不支持的 scheme（如 javascript:, about:blank）当成纯文本。
 */
export function formatReferer(url: string | undefined | null): string {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (!trimmed) return '';
    // 拒绝危险 scheme（防 XSS 通过 javascript: 链接）
    if (/^(javascript|data|file|about):/i.test(trimmed)) {
        return escapeHtml(trimmed);
    }
    try {
        const parsed = new URL(trimmed);
        // 只允许 http/https
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return escapeHtml(trimmed);
        }
        const hostname = parsed.hostname || trimmed;
        return link(hostname, trimmed);
    } catch {
        // 解析失败时尝试当成相对路径，原样显示
        return escapeHtml(trimmed);
    }
}

// ============ Extract Contact Card from Webhook Payload ============

/** 工具：从多个来源中取首个非空值。
 *  - null/undefined 永远跳过
 *  - 空字符串 ''/空对象 视为"无值"跳过（避免 conv 上 referer="" 把 contact 的真实 URL 挤掉）
 *  - 0/false 保留（视为有效值，用于数字/布尔字段）
 */
function pickFirst<T>(...candidates: Array<T | undefined | null>): T | undefined {
    for (const c of candidates) {
        if (c == null) continue;
        if (typeof c === 'string' && c.length === 0) continue;
        if (typeof c === 'object' && !Array.isArray(c) && Object.keys(c as object).length === 0) continue;
        return c;
    }
    return undefined;
}

/**
 * 从 webhook payload 中提取联系人完整信息。
 *
 * 优先级策略（关键）：
 * - 会话级（conversation.additional_attributes）→ 联系人级（sender 或 meta.sender 的 additional_attributes）
 *   适用于「当前会话的实时数据」：browser、browser_language、referer、initiated_at、created_at_ip、updated_at_ip
 * - 联系人级（contact）→ 会话级
 *   适用于「持久属性」：country、city、country_code（一般由 IP 反查异步写入到 contact 上）
 *
 * 这与 Chatwoot 后台「对话信息」面板的字段来源完全一致：
 * - 发起于/语言/启动自/浏览器/操作系统 全部读 conversation.additional_attributes
 * - IP 读 contact.additional_attributes.created_at_ip（但若 conv 上有则优先用）
 */
export function extractContactCard(event: ChatwootMessageEvent): ContactCardInfo {
    const conversation = event.conversation;
    const messageSender = event.sender;
    const metaSender = conversation?.meta?.sender;

    // 联系人快照：incoming 时 sender 即为联系人；outgoing 时只有 meta.sender 才是联系人
    const isIncomingContact = event.message_type === 'incoming' && messageSender?.type !== 'user';
    const contact: ChatwootSender | undefined = isIncomingContact ? messageSender : metaSender;

    const name = contact?.name || metaSender?.name || '匿名联系人';

    // 持久的联系人属性（contact level，registered country/city）
    const contactAttrs: ChatwootAdditionalAttributes =
        contact?.additional_attributes || metaSender?.additional_attributes || {};

    // 当前会话属性（conversation level，本次会话的浏览器/IP/referer 等）
    const convAttrs: ChatwootAdditionalAttributes = conversation?.additional_attributes || {};

    // 会话级优先（每字段单独 fallback，避免 contact 上有 browser、conv 上有 browser_language 时漏读）
    const browser: ChatwootBrowserInfo | undefined =
        pickFirst<ChatwootBrowserInfo>(convAttrs.browser, contactAttrs.browser);
    const browserLanguage = pickFirst<string>(convAttrs.browser_language, contactAttrs.browser_language);
    const referer = pickFirst<string>(
        typeof convAttrs.referer === 'string' ? convAttrs.referer : undefined,
        typeof contactAttrs.referer === 'string' ? contactAttrs.referer : undefined,
    );
    const initiatedAtRaw = pickFirst<unknown>(
        convAttrs.initiated_at?.timestamp,
        contactAttrs.initiated_at?.timestamp,
    );
    // IP：优先取 updated_at_ip（最近一次更新），再 created_at_ip（首次访问）；
    // 与 Chatwoot ContactIpLookupJob 的 get_contact_ip 顺序一致。
    const createdAtIp = pickFirst<string>(
        typeof (convAttrs as Record<string, unknown>).updated_at_ip === 'string' ? (convAttrs as Record<string, string>).updated_at_ip : undefined,
        typeof (contactAttrs as Record<string, unknown>).updated_at_ip === 'string' ? (contactAttrs as Record<string, string>).updated_at_ip : undefined,
        typeof convAttrs.created_at_ip === 'string' ? convAttrs.created_at_ip : undefined,
        typeof contactAttrs.created_at_ip === 'string' ? contactAttrs.created_at_ip : undefined,
    );

    const initiatedAt = parseTimestamp(initiatedAtRaw);

    return {
        contactId: contact?.id ?? metaSender?.id,
        name,
        email: contact?.email || metaSender?.email,
        phoneNumber: contact?.phone_number || metaSender?.phone_number,
        identifier: contact?.identifier || metaSender?.identifier,
        sourceId: conversation?.contact_inbox?.source_id,
        channel: conversation?.channel || event.inbox?.channel_type,
        inboxName: event.inbox?.name,
        // 持久属性（country / city / country_code）：固定从 contact 读
        country: typeof contactAttrs.country === 'string' ? contactAttrs.country : undefined,
        city: typeof contactAttrs.city === 'string' ? contactAttrs.city : undefined,
        countryCode: typeof contactAttrs.country_code === 'string' ? contactAttrs.country_code : undefined,
        // 会话级属性（browser 整体来自上面的 pickFirst 结果）
        browserName: browser?.browser_name,
        browserVersion: browser?.browser_version,
        platformName: browser?.platform_name,
        platformVersion: browser?.platform_version,
        deviceName: browser?.device_name,
        browserLanguage,
        referer,
        createdAtIp,
        initiatedAt,
        customAttributes: contact?.custom_attributes,
        labels: conversation?.labels,
    };
}

/**
 * 「刷新最新资料」专用：把两路 API 结果（当前会话 + 联系人）合并成完整 ContactCardInfo。
 *
 * 为什么需要它：单点击「刷新」只调 getContact，拿到的是「联系人维度」数据，
 * 缺少 Chatwoot「对话信息」面板里这些「会话维度」字段——
 *   🔑 source_id、📥 渠道、🕒 发起于、🗣️ 浏览器语言、🔗 启动自、🌐 浏览器、📡 IP、💻 操作系统。
 * 这些都只存在于 conversation（contact_inbox.source_id / channel / additional_attributes）。
 *
 * 实现上构造一个合成的 incoming 事件后复用 extractContactCard，
 * 这样刷新视图与初始卡片走完全相同的字段优先级逻辑（会话级优先），二者字段一一对应。
 * 渠道收件箱名称从 contact.contact_inboxes 按本会话 source_id 匹配补齐。
 */
export function buildContactCardFromApi(
    conversation: ChatwootConversation,
    contact: ChatwootContactDetail,
): ContactCardInfo {
    const sourceId = conversation.contact_inbox?.source_id;
    const matchedInbox =
        contact.contact_inboxes?.find((ci) => ci.source_id === sourceId)?.inbox ??
        contact.contact_inboxes?.[0]?.inbox;

    const syntheticEvent: ChatwootMessageEvent = {
        event: 'message_created',
        message_type: 'incoming',
        // 用最新的 getContact 结果当 sender（邮箱/标识/自定义属性/国家城市以它为准）
        sender: {
            id: contact.id,
            name: contact.name,
            email: contact.email,
            phone_number: contact.phone_number,
            identifier: contact.identifier,
            type: 'contact',
            additional_attributes: contact.additional_attributes,
            custom_attributes: contact.custom_attributes,
        },
        conversation,
        inbox: matchedInbox
            ? { id: matchedInbox.id, name: matchedInbox.name, channel_type: matchedInbox.channel_type }
            : undefined,
    };

    return extractContactCard(syntheticEvent);
}

function parseTimestamp(raw: unknown): number | undefined {
    if (raw == null) return undefined;
    if (typeof raw === 'number') {
        // 区分秒/毫秒：> 1e12 视为毫秒
        return raw > 1e12 ? Math.floor(raw / 1000) : raw;
    }
    if (typeof raw === 'string') {
        const n = Number(raw);
        if (!Number.isNaN(n)) return parseTimestamp(n);
        const d = Date.parse(raw);
        if (!Number.isNaN(d)) return Math.floor(d / 1000);
    }
    return undefined;
}

// ============ Render Contact Card (HTML) ============

/**
 * 把秒级时间戳偏移到北京时间（UTC+8，中国无夏令时，固定偏移即可）。
 * 之后统一用 getUTC* 读取，读出来的就是北京时间各字段——
 * 这样不受运行服务器本地时区影响，部署在任何机器上显示都是北京时间。
 */
function toBeijing(seconds: number): Date {
    return new Date((seconds + 8 * 3600) * 1000);
}

function formatTimestamp(seconds: number): string {
    const d = toBeijing(seconds);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 拼浏览器字符串：name + version；只有 name 时只显示 name；都没有时返回空 */
function joinBrowser(name?: string, version?: string): string {
    if (!name) return '';
    return version ? `${name} ${version}` : name;
}

/** 拼操作系统字符串：platform_name + platform_version；fallback 到 device_name */
function joinOs(platformName?: string, platformVersion?: string, deviceName?: string): string {
    if (platformName) {
        return platformVersion ? `${platformName} ${platformVersion}` : platformName;
    }
    return deviceName || '';
}

/**
 * 渲染联系人完整卡片（HTML 格式，可直接作为 sendMessage 内容）。
 *
 * 字段顺序与 Chatwoot 后台「对话信息」面板一致：
 *   身份（姓名/邮箱/电话/标识）→ 渠道/来源 → 持久位置 → 会话信息（发起/语言/启动自/浏览器/IP/OS）→ 标签 → 自定义属性
 *
 * @param definitions 自定义属性定义列表（含中文 display_name + 类型）。
 *                    传空数组时降级用英文键名渲染。
 */
export function renderContactCard(
    info: ContactCardInfo,
    conversationId: number,
    definitions: CustomAttributeDefinition[] = [],
    options: { footer?: boolean } = {},
): string {
    const lines: string[] = [];

    // === 身份 ===
    lines.push(`👤 <b>${escapeHtml(info.name)}</b>  <code>#${conversationId}</code>`);
    lines.push('━━━━━━━━━━━━━━━━');

    if (info.email) lines.push(`📧 ${escapeHtml(info.email)}`);
    if (info.phoneNumber) lines.push(`📞 ${escapeHtml(info.phoneNumber)}`);
    if (info.identifier && info.identifier !== info.email) {
        lines.push(`🆔 ${escapeHtml(info.identifier)}`);
    }
    if (info.sourceId && info.sourceId !== info.identifier && info.sourceId !== info.email) {
        lines.push(`🔑 ${escapeHtml(info.sourceId)}`);
    }

    // === 渠道 ===
    const channelText = channelLabel(info.channel);
    const inboxSuffix = info.inboxName ? ` · ${escapeHtml(info.inboxName)}` : '';
    lines.push(`📥 ${channelText}${inboxSuffix}`);

    // === 持久位置（contact-level）===
    const locationParts: string[] = [];
    if (info.country) locationParts.push(info.country);
    if (info.city) locationParts.push(info.city);
    if (locationParts.length > 0) {
        lines.push(`📍 ${escapeHtml(locationParts.join(' · '))}`);
    } else if (info.countryCode) {
        lines.push(`📍 ${escapeHtml(info.countryCode)}`);
    }

    // === 会话信息（conversation-level，匹配 Chatwoot 对话信息面板顺序）===
    // 单独写一个块，所有字段都有 <b>label</b>：value 前缀，整齐排版
    if (info.initiatedAt) {
        lines.push(`🕒 <b>发起于</b>：${formatTimestamp(info.initiatedAt)}`);
    }
    if (info.browserLanguage) {
        const label = languageLabel(info.browserLanguage);
        lines.push(`🗣️ <b>浏览器语言</b>：${escapeHtml(label)}`);
    }
    if (info.referer) {
        lines.push(`🔗 <b>启动自</b>：${formatReferer(info.referer)}`);
    }
    const browserText = joinBrowser(info.browserName, info.browserVersion);
    if (browserText) {
        lines.push(`🌐 <b>浏览器</b>：${escapeHtml(browserText)}`);
    }
    if (info.createdAtIp) {
        lines.push(`📡 <b>IP</b>：${escapeHtml(info.createdAtIp)}`);
    }
    const osText = joinOs(info.platformName, info.platformVersion, info.deviceName);
    if (osText) {
        lines.push(`💻 <b>操作系统</b>：${escapeHtml(osText)}`);
    }

    // === 标签 ===
    if (info.labels && info.labels.length > 0) {
        lines.push(`🏷️ ${info.labels.map((l) => escapeHtml(l)).join(' · ')}`);
    }

    // === 自定义属性 ===
    const custom = info.customAttributes || {};
    const customKeys = Object.keys(custom).filter((k) => {
        const v = custom[k];
        return v != null && v !== '';
    });
    if (customKeys.length > 0) {
        lines.push('');
        lines.push('📊 <b>客户自定义属性</b>');

        const rendered = new Set<string>();
        // 按 definition 顺序优先（保留 Chatwoot 后台的配置顺序）
        for (const def of definitions) {
            if (!customKeys.includes(def.attribute_key)) continue;
            const value = custom[def.attribute_key];
            const formatted = formatCustomAttributeValue(value, def.attribute_display_type);
            lines.push(`• <b>${escapeHtml(def.attribute_display_name)}</b>：${formatted}`);
            rendered.add(def.attribute_key);
        }
        // 未配定义的属性降级显示键名（不丢数据）
        for (const key of customKeys) {
            if (rendered.has(key)) continue;
            lines.push(`• <code>${escapeHtml(key)}</code>：${escapeHtml(String(custom[key]))}`);
        }
    }

    // footer 默认显示（初始卡片底部有操作按钮）；刷新视图是独立回复、无按钮，传 footer:false 关闭。
    if (options.footer !== false) {
        lines.push('');
        lines.push('💬 <i>点击下方按钮管理此对话</i>');
    }

    return lines.join('\n');
}

// ============ Custom Attributes Formatting ============

/**
 * 按 Chatwoot 自定义属性类型格式化值。
 * - text/list/number 原样显示
 * - currency 加 ¥ 前缀
 * - percent 加 % 后缀
 * - link 渲染为可点击链接
 * - date 按 yyyy-MM-dd 显示
 * - checkbox 转 ✅/❌
 */
export function formatCustomAttributeValue(value: unknown, type: CustomAttributeType | string): string {
    if (value == null || value === '') return '—';

    switch (type) {
        case 'currency':
            return `¥${escapeHtml(String(value))}`;
        case 'percent':
            return `${escapeHtml(String(value))}%`;
        case 'link': {
            const url = String(value);
            return `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
        }
        case 'date': {
            const ts = parseTimestamp(value);
            if (ts) {
                const d = toBeijing(ts);
                const pad = (n: number) => String(n).padStart(2, '0');
                return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
            }
            return escapeHtml(String(value));
        }
        case 'checkbox':
            return value === true || value === 'true' || value === 1 ? '✅' : '❌';
        case 'number':
        case 'text':
        case 'list':
        default:
            return escapeHtml(String(value));
    }
}

/**
 * 渲染「客户详细资料」消息：联系人完整资料 + 按中文名翻译的自定义属性。
 * 字段顺序与 renderContactCard 保持一致，让"刷新按钮"得到的视图与卡片完全可对比。
 *
 * 注意：本函数接收的是 contact API 的返回（contact 维度），不含 conversation 维度信息。
 * 因此 browser/referer/language/initiated_at 只来自 contact.additional_attributes
 * （可能是历史首次注册时的值，或被 IP lookup job 更新过）。
 * 如果需要"当前会话"的浏览器信息，请看初始卡片，而非本刷新视图。
 */
export function renderContactDetailMessage(
    contact: ChatwootContactDetail,
    definitions: CustomAttributeDefinition[],
): string {
    const lines: string[] = [];
    lines.push(`👤 <b>${escapeHtml(contact.name || '匿名联系人')}</b>`);
    lines.push('━━━━━━━━━━━━━━━━');

    if (contact.email) lines.push(`📧 ${escapeHtml(contact.email)}`);
    if (contact.phone_number) lines.push(`📞 ${escapeHtml(contact.phone_number)}`);
    if (contact.identifier) lines.push(`🆔 ${escapeHtml(contact.identifier)}`);

    const a: ChatwootAdditionalAttributes = contact.additional_attributes || {};

    // 持久位置
    const locationParts: string[] = [];
    if (typeof a.country === 'string') locationParts.push(a.country);
    if (typeof a.city === 'string') locationParts.push(a.city);
    if (locationParts.length > 0) lines.push(`📍 ${escapeHtml(locationParts.join(' · '))}`);
    else if (typeof a.country_code === 'string') lines.push(`📍 ${escapeHtml(a.country_code)}`);

    // 会话信息
    if (a.initiated_at?.timestamp != null) {
        const ts = parseTimestamp(a.initiated_at.timestamp);
        if (ts) lines.push(`🕒 <b>发起于</b>：${formatTimestamp(ts)}`);
    }
    if (typeof a.browser_language === 'string') {
        lines.push(`🗣️ <b>浏览器语言</b>：${escapeHtml(languageLabel(a.browser_language))}`);
    }
    if (typeof a.referer === 'string' && a.referer) {
        lines.push(`🔗 <b>启动自</b>：${formatReferer(a.referer)}`);
    }
    const browserStr = joinBrowser(a.browser?.browser_name, a.browser?.browser_version);
    if (browserStr) lines.push(`🌐 <b>浏览器</b>：${escapeHtml(browserStr)}`);
    const ip = (a as Record<string, unknown>).updated_at_ip || a.created_at_ip;
    if (typeof ip === 'string') lines.push(`📡 <b>IP</b>：${escapeHtml(ip)}`);
    const osStr = joinOs(a.browser?.platform_name, a.browser?.platform_version, a.browser?.device_name);
    if (osStr) lines.push(`💻 <b>操作系统</b>：${escapeHtml(osStr)}`);

    // 自定义属性
    const custom = contact.custom_attributes || {};
    const customKeys = Object.keys(custom).filter((k) => custom[k] != null && custom[k] !== '');

    if (customKeys.length > 0) {
        lines.push('');
        lines.push('📊 <b>客户自定义属性</b>');

        const rendered = new Set<string>();
        for (const def of definitions) {
            if (!customKeys.includes(def.attribute_key)) continue;
            const value = custom[def.attribute_key];
            const formatted = formatCustomAttributeValue(value, def.attribute_display_type);
            lines.push(`• <b>${escapeHtml(def.attribute_display_name)}</b>：${formatted}`);
            rendered.add(def.attribute_key);
        }
        for (const key of customKeys) {
            if (rendered.has(key)) continue;
            lines.push(`• <code>${escapeHtml(key)}</code>：${escapeHtml(String(custom[key]))}`);
        }
    }

    return lines.join('\n');
}

// ============ Render Per-Message Forwarded Text ============

/**
 * 渲染转发到 Telegram 的单条消息文本。
 * - 元数据（姓名、邮箱）只做 HTML escape，避免 Markdown 误解释
 * - 消息正文用 markdownToTelegramHtml，让 Chatwoot AI/客服回复里的
 *   **bold**、[text](url)、`code` 等格式在 Telegram 端正常渲染
 */
export function renderForwardedMessage(params: {
    messageType: 'incoming' | 'outgoing';
    senderName: string;
    senderEmail?: string;
    content: string;
    attachmentCount: number;
}): string {
    const { messageType, senderName, senderEmail, content, attachmentCount } = params;
    const safeName = escapeHtml(senderName);
    const safeEmail = senderEmail ? ` (${escapeHtml(senderEmail)})` : '';
    const safeBody = markdownToTelegramHtml(content);
    const attachmentHint = attachmentCount > 0 ? `\n📎 附件：${attachmentCount} 个` : '';

    if (messageType === 'incoming') {
        return `👤 <b>${safeName}</b>${safeEmail}\n💬 ${safeBody}${attachmentHint}`;
    }
    return `🤖 <b>${safeName}</b> (客服/AI)\n📤 ${safeBody}${attachmentHint}`;
}

// ============ Helpers for Extracting Display Name (backward compat) ============

/**
 * 从 webhook event 提取用于话题标题的联系人名称。
 * 与 extractContactCard 同源逻辑，但不构造完整卡片。
 */
export function extractContactDisplayName(event: ChatwootMessageEvent): string {
    return extractContactCard(event).name;
}

export function extractSenderName(event: ChatwootMessageEvent): { name: string; email: string } {
    const messageSender = event.sender;
    const metaSender = event.conversation?.meta?.sender;

    if (event.message_type === 'incoming') {
        return {
            name: messageSender?.name || metaSender?.name || '匿名联系人',
            email: messageSender?.email || metaSender?.email || '',
        };
    }
    return {
        name: messageSender?.name || '客服',
        email: messageSender?.email || '',
    };
}

// Internal exports used in tests
export const __test__ = { parseTimestamp, channelLabel, joinBrowser, joinOs, formatTimestamp };
