import type { ChatwootMessageEvent, ContactCardInfo, ChatwootSender, ChatwootConversation, ChatwootInbox } from './types';

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
 */
export function renderContactCard(info: ContactCardInfo, conversationId: number): string {
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

    if (info.customAttributes && Object.keys(info.customAttributes).length > 0) {
        const ca = Object.entries(info.customAttributes)
            .filter(([, v]) => v != null && v !== '')
            .slice(0, 5)
            .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
            .join(', ');
        if (ca) lines.push(`📝 ${ca}`);
    }

    lines.push('');
    lines.push('💬 <i>点击下方按钮管理此对话</i>');

    return lines.join('\n');
}

// ============ Render Per-Message Forwarded Text ============

/**
 * 渲染转发到 Telegram 的单条消息文本。
 * 使用 HTML parse_mode 避免 Markdown 注入。
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
    const safeBody = escapeHtml(content);
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
