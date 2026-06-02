import type {
    ChatwootMessageEvent,
    ContactCardInfo,
    ChatwootSender,
    ChatwootContactDetail,
    CustomAttributeDefinition,
    CustomAttributeType,
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

// ============ Channel Name Mapping ============

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

// ============ Extract Contact Card from Webhook Payload ============

/**
 * 从 webhook payload 中提取联系人完整信息。
 * 优先级：sender (incoming) > conversation.meta.sender；conversation.additional_attributes 兜底浏览器信息。
 */
export function extractContactCard(event: ChatwootMessageEvent): ContactCardInfo {
    const conversation = event.conversation;
    const messageSender = event.sender;
    const metaSender = conversation?.meta?.sender;

    // 联系人信息：incoming 时 sender 即为联系人；outgoing 时只有 meta.sender 才是联系人
    const isIncomingContact = event.message_type === 'incoming' && messageSender?.type !== 'user';
    const contact: ChatwootSender | undefined = isIncomingContact ? messageSender : metaSender;

    const name = contact?.name || metaSender?.name || '匿名联系人';
    const additional = contact?.additional_attributes || metaSender?.additional_attributes || {};
    const convAdditional = conversation?.additional_attributes || {};
    // 浏览器信息：联系人级和对话级都可能有，取联系人优先，对话兜底
    const browser = additional.browser || convAdditional.browser;
    const browserLanguage = additional.browser_language || convAdditional.browser_language;
    const referer = additional.referer || convAdditional.referer;
    const initiatedAtRaw = additional.initiated_at?.timestamp ?? convAdditional.initiated_at?.timestamp;
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
        country: typeof additional.country === 'string' ? additional.country : undefined,
        city: typeof additional.city === 'string' ? additional.city : undefined,
        countryCode: typeof additional.country_code === 'string' ? additional.country_code : undefined,
        browserName: browser?.browser_name,
        browserVersion: browser?.browser_version,
        platformName: browser?.platform_name,
        deviceName: browser?.device_name,
        browserLanguage,
        referer: typeof referer === 'string' ? referer : undefined,
        createdAtIp: typeof additional.created_at_ip === 'string' ? additional.created_at_ip : undefined,
        initiatedAt,
        customAttributes: contact?.custom_attributes,
        labels: conversation?.labels,
    };
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

function formatTimestamp(seconds: number): string {
    const d = new Date(seconds * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 渲染联系人完整卡片（HTML 格式，可直接作为 sendMessage 内容）。
 * 自动隐藏空字段。
 *
 * @param definitions 自定义属性定义列表（含中文 display_name + 类型）。
 *                    传空数组时降级用英文键名渲染。
 */
export function renderContactCard(
    info: ContactCardInfo,
    conversationId: number,
    definitions: CustomAttributeDefinition[] = [],
): string {
    const lines: string[] = [];
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

    // 来源
    const channelText = channelLabel(info.channel);
    const inboxSuffix = info.inboxName ? ` · ${escapeHtml(info.inboxName)}` : '';
    lines.push(`📥 ${channelText}${inboxSuffix}`);

    // 位置
    const locationParts = [info.country, info.city].filter(Boolean) as string[];
    if (locationParts.length > 0) {
        lines.push(`📍 ${escapeHtml(locationParts.join(' · '))}`);
    }

    // 设备/浏览器
    const deviceParts: string[] = [];
    if (info.browserName) {
        deviceParts.push(info.browserVersion ? `${info.browserName} ${info.browserVersion}` : info.browserName);
    }
    if (info.platformName) deviceParts.push(info.platformName);
    if (info.deviceName && info.deviceName !== info.platformName) deviceParts.push(info.deviceName);
    if (deviceParts.length > 0) {
        lines.push(`💻 ${escapeHtml(deviceParts.join(' · '))}`);
    }

    if (info.browserLanguage) lines.push(`🗣️ ${escapeHtml(info.browserLanguage)}`);
    if (info.referer) lines.push(`🔗 ${link('来源页面', info.referer)}`);
    if (info.createdAtIp) lines.push(`🌐 IP：${escapeHtml(info.createdAtIp)}`);
    if (info.initiatedAt) lines.push(`🕒 首次访问：${formatTimestamp(info.initiatedAt)}`);

    if (info.labels && info.labels.length > 0) {
        lines.push(`🏷️ ${info.labels.map((l) => escapeHtml(l)).join(' · ')}`);
    }

    // 自定义属性：按中文 display_name + 类型化的值直接展示在卡片里。
    // 没有 definitions 时降级显示原始键名（按钮可用于刷新）。
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

    lines.push('');
    lines.push('💬 <i>点击下方按钮管理此对话</i>');

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
                const d = new Date(ts * 1000);
                const pad = (n: number) => String(n).padStart(2, '0');
                return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
 * 没有 definitions 时降级显示原始键名。
 */
export function renderContactDetailMessage(
    contact: ChatwootContactDetail,
    definitions: CustomAttributeDefinition[],
): string {
    const lines: string[] = [];
    lines.push(`👤 <b>${escapeHtml(contact.name || '匿名联系人')}</b>`);
    lines.push('━━━━━━━━━━━━━━━━');

    // 基础信息
    if (contact.email) lines.push(`📧 ${escapeHtml(contact.email)}`);
    if (contact.phone_number) lines.push(`📞 ${escapeHtml(contact.phone_number)}`);
    if (contact.identifier) lines.push(`🆔 ${escapeHtml(contact.identifier)}`);

    // 额外属性（country / city / browser / referer 等系统字段）
    const a = contact.additional_attributes || {};
    const locationParts: string[] = [];
    if (typeof a.country === 'string') locationParts.push(a.country);
    if (typeof a.city === 'string') locationParts.push(a.city);
    if (locationParts.length > 0) lines.push(`📍 ${escapeHtml(locationParts.join(' · '))}`);
    if (typeof a.created_at_ip === 'string') lines.push(`🌐 IP：${escapeHtml(a.created_at_ip)}`);
    if (a.browser?.browser_name) {
        const browser = a.browser.browser_version ? `${a.browser.browser_name} ${a.browser.browser_version}` : a.browser.browser_name;
        const platform = a.browser.platform_name ? ` · ${a.browser.platform_name}` : '';
        lines.push(`💻 ${escapeHtml(browser)}${escapeHtml(platform)}`);
    }
    if (typeof a.browser_language === 'string') lines.push(`🗣️ ${escapeHtml(a.browser_language)}`);

    // 自定义属性区
    const custom = contact.custom_attributes || {};
    const customKeys = Object.keys(custom).filter((k) => custom[k] != null && custom[k] !== '');

    if (customKeys.length > 0) {
        lines.push('');
        lines.push('📊 <b>客户自定义属性</b>');

        // 用 attribute_key → definition 建索引
        const defByKey = new Map<string, CustomAttributeDefinition>();
        for (const def of definitions) defByKey.set(def.attribute_key, def);

        // 按 definition 顺序渲染（保证管理员配置的顺序），再追加未定义的
        const rendered = new Set<string>();
        for (const def of definitions) {
            if (!customKeys.includes(def.attribute_key)) continue;
            const value = custom[def.attribute_key];
            const formatted = formatCustomAttributeValue(value, def.attribute_display_type);
            lines.push(`• <b>${escapeHtml(def.attribute_display_name)}</b>：${formatted}`);
            rendered.add(def.attribute_key);
        }
        // 未定义的（webhook 里有但管理员没配 definition）
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
export const __test__ = { parseTimestamp, channelLabel };
