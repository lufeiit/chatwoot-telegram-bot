import { describe, it, expect } from 'vitest';
import {
    escapeHtml,
    extractContactCard,
    renderContactCard,
    renderForwardedMessage,
    extractSenderName,
    markdownToTelegramHtml,
    formatCustomAttributeValue,
    renderContactDetailMessage,
    __test__,
} from '../formatters';
import type { ChatwootMessageEvent, ChatwootContactDetail, CustomAttributeDefinition } from '../types';

describe('escapeHtml', () => {
    it('escapes & < > but leaves quotes', () => {
        expect(escapeHtml('a & b <c> "d"')).toBe('a &amp; b &lt;c&gt; "d"');
    });
    it('returns empty string for empty input', () => {
        expect(escapeHtml('')).toBe('');
    });
});

describe('parseTimestamp', () => {
    const parse = __test__.parseTimestamp;
    it('passes through seconds-resolution numbers', () => {
        expect(parse(1717286400)).toBe(1717286400);
    });
    it('converts millisecond numbers', () => {
        expect(parse(1717286400000)).toBe(1717286400);
    });
    it('parses numeric strings', () => {
        expect(parse('1717286400')).toBe(1717286400);
    });
    it('parses ISO strings', () => {
        const t = parse('2024-06-02T00:00:00Z');
        expect(t).toBe(Math.floor(Date.UTC(2024, 5, 2) / 1000));
    });
    it('returns undefined for nullish', () => {
        expect(parse(null)).toBeUndefined();
        expect(parse(undefined)).toBeUndefined();
    });
});

describe('extractContactCard', () => {
    it('extracts full info from incoming web-widget event', () => {
        const event: ChatwootMessageEvent = {
            event: 'message_created',
            id: 100,
            message_type: 'incoming',
            content: 'hi',
            sender: {
                id: 42,
                type: 'contact',
                name: '张三',
                email: 'foo@bar.com',
                phone_number: '+8613800138000',
                identifier: 'user_42',
                additional_attributes: {
                    country: '中国',
                    city: '上海',
                    country_code: 'CN',
                    browser_language: 'zh-CN',
                    referer: 'https://example.com/pricing',
                    created_at_ip: '1.2.3.4',
                    initiated_at: { timestamp: 1717286400 },
                    browser: {
                        browser_name: 'Chrome',
                        browser_version: '138.0',
                        platform_name: 'macOS',
                        device_name: 'Mac',
                    },
                },
                custom_attributes: { vip: true, tier: 'gold' },
            },
            conversation: {
                id: 9,
                contact_inbox: { source_id: 'src-abc' },
                channel: 'Channel::WebWidget',
                labels: ['sales', 'priority'],
            },
            inbox: { id: 1, name: '官网', channel_type: 'Channel::WebWidget' },
        };

        const card = extractContactCard(event);
        expect(card.contactId).toBe(42);
        expect(card.name).toBe('张三');
        expect(card.email).toBe('foo@bar.com');
        expect(card.phoneNumber).toBe('+8613800138000');
        expect(card.identifier).toBe('user_42');
        expect(card.sourceId).toBe('src-abc');
        expect(card.channel).toBe('Channel::WebWidget');
        expect(card.inboxName).toBe('官网');
        expect(card.country).toBe('中国');
        expect(card.city).toBe('上海');
        expect(card.browserName).toBe('Chrome');
        expect(card.browserVersion).toBe('138.0');
        expect(card.platformName).toBe('macOS');
        expect(card.deviceName).toBe('Mac');
        expect(card.browserLanguage).toBe('zh-CN');
        expect(card.referer).toBe('https://example.com/pricing');
        expect(card.createdAtIp).toBe('1.2.3.4');
        expect(card.initiatedAt).toBe(1717286400);
        expect(card.customAttributes).toEqual({ vip: true, tier: 'gold' });
        expect(card.labels).toEqual(['sales', 'priority']);
    });

    it('falls back to meta.sender on outgoing message', () => {
        const event: ChatwootMessageEvent = {
            event: 'message_created',
            message_type: 'outgoing',
            sender: { type: 'user', name: '客服小李' },
            conversation: {
                id: 1,
                meta: { sender: { name: '李四', email: 'l@b.com' } },
            },
        };
        const card = extractContactCard(event);
        expect(card.name).toBe('李四');
        expect(card.email).toBe('l@b.com');
    });

    it('uses fallback name when nothing is available', () => {
        const event: ChatwootMessageEvent = {
            event: 'message_created',
            message_type: 'incoming',
            conversation: { id: 1 },
        };
        const card = extractContactCard(event);
        expect(card.name).toBe('匿名联系人');
    });
});

describe('renderContactCard', () => {
    it('renders a complete card with all fields', () => {
        const text = renderContactCard({
            name: '张三',
            email: 'foo@bar.com',
            phoneNumber: '+86 138',
            identifier: 'user_42',
            sourceId: 'src-abc',
            channel: 'Channel::WebWidget',
            inboxName: '官网',
            country: '中国',
            city: '上海',
            browserName: 'Chrome',
            browserVersion: '138',
            platformName: 'macOS',
            browserLanguage: 'zh-CN',
            referer: 'https://e.com/p?x=1&y=2',
            initiatedAt: 1717286400,
        }, 9);
        expect(text).toContain('<b>张三</b>');
        expect(text).toContain('#9');
        expect(text).toContain('foo@bar.com');
        expect(text).toContain('🌐 网页咨询');
        expect(text).toContain('官网');
        expect(text).toContain('中国 · 上海');
        expect(text).toContain('Chrome 138');
        expect(text).toContain('macOS');
        expect(text).toContain('zh-CN');
        // URL & 被转义
        expect(text).toContain('href="https://e.com/p?x=1&amp;y=2"');
    });

    it('skips missing fields', () => {
        const text = renderContactCard({ name: '匿名联系人' }, 1);
        expect(text).toContain('匿名联系人');
        expect(text).not.toContain('📧');
        expect(text).not.toContain('📞');
        expect(text).not.toContain('💻');
    });

    it('escapes HTML in name to prevent injection', () => {
        const text = renderContactCard({ name: '<script>x</script>' }, 1);
        expect(text).toContain('&lt;script&gt;x&lt;/script&gt;');
        expect(text).not.toContain('<script>');
    });
});

describe('renderForwardedMessage', () => {
    it('renders Markdown in content while keeping sender name safe', () => {
        const text = renderForwardedMessage({
            messageType: 'incoming',
            senderName: '张_三*',
            senderEmail: 'a@b.com',
            content: '请看 **重要内容** 和 [点此查看](https://e.com)',
            attachmentCount: 2,
        });
        // 姓名只 escape，不解释 Markdown
        expect(text).toContain('<b>张_三*</b>');
        expect(text).toContain('(a@b.com)');
        // 正文里的 Markdown 应被转换成 HTML
        expect(text).toContain('<b>重要内容</b>');
        expect(text).toContain('<a href="https://e.com">点此查看</a>');
        expect(text).toContain('📎 附件：2 个');
    });

    it('escapes HTML in content but keeps Markdown formatting', () => {
        const text = renderForwardedMessage({
            messageType: 'outgoing',
            senderName: '客服',
            content: '代码: `<script>` 还有 **加粗**',
            attachmentCount: 0,
        });
        expect(text).not.toContain('<script>');
        expect(text).toContain('<code>&lt;script&gt;</code>');
        expect(text).toContain('<b>加粗</b>');
    });

    it('omits attachment hint when count is 0', () => {
        const text = renderForwardedMessage({
            messageType: 'outgoing',
            senderName: '客服',
            content: 'hi',
            attachmentCount: 0,
        });
        expect(text).not.toContain('📎');
        expect(text).toContain('🤖');
    });
});

describe('formatCustomAttributeValue', () => {
    it('returns — for empty values', () => {
        expect(formatCustomAttributeValue(null, 'text')).toBe('—');
        expect(formatCustomAttributeValue('', 'text')).toBe('—');
        expect(formatCustomAttributeValue(undefined, 'number')).toBe('—');
    });
    it('formats text/number/list as plain escaped string', () => {
        expect(formatCustomAttributeValue('hello <a>', 'text')).toBe('hello &lt;a&gt;');
        expect(formatCustomAttributeValue(42, 'number')).toBe('42');
        expect(formatCustomAttributeValue('vip', 'list')).toBe('vip');
    });
    it('prefixes currency with ¥', () => {
        expect(formatCustomAttributeValue(100, 'currency')).toBe('¥100');
    });
    it('suffixes percent with %', () => {
        expect(formatCustomAttributeValue(75, 'percent')).toBe('75%');
    });
    it('renders link as clickable <a>', () => {
        expect(formatCustomAttributeValue('https://e.com/a?x=1&y=2', 'link'))
            .toBe('<a href="https://e.com/a?x=1&amp;y=2">https://e.com/a?x=1&amp;y=2</a>');
    });
    it('formats checkbox as ✅/❌', () => {
        expect(formatCustomAttributeValue(true, 'checkbox')).toBe('✅');
        expect(formatCustomAttributeValue('true', 'checkbox')).toBe('✅');
        expect(formatCustomAttributeValue(1, 'checkbox')).toBe('✅');
        expect(formatCustomAttributeValue(false, 'checkbox')).toBe('❌');
        expect(formatCustomAttributeValue('false', 'checkbox')).toBe('❌');
    });
    it('formats date from ISO or unix timestamp', () => {
        expect(formatCustomAttributeValue('2024-06-02T12:00:00Z', 'date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(formatCustomAttributeValue(1717286400, 'date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
    it('falls back to escaped string for unknown type', () => {
        expect(formatCustomAttributeValue('x<>', 'unknown_type')).toBe('x&lt;&gt;');
    });
});

describe('renderContactDetailMessage', () => {
    const definitions: CustomAttributeDefinition[] = [
        { id: 1, attribute_display_name: 'Xboard 状态', attribute_display_type: 'list', attribute_key: 'xboard_status', attribute_model: 'contact_attribute' },
        { id: 2, attribute_display_name: '账户余额', attribute_display_type: 'currency', attribute_key: 'xboard_balance', attribute_model: 'contact_attribute' },
        { id: 3, attribute_display_name: '已用流量(GB)', attribute_display_type: 'number', attribute_key: 'xboard_used_gb', attribute_model: 'contact_attribute' },
        { id: 4, attribute_display_name: '订阅链接', attribute_display_type: 'link', attribute_key: 'xboard_subscribe_url', attribute_model: 'contact_attribute' },
        { id: 5, attribute_display_name: 'Xboard 同步时间', attribute_display_type: 'date', attribute_key: 'xboard_synced_at', attribute_model: 'contact_attribute' },
    ];

    it('renders contact with custom attributes using Chinese display names', () => {
        const contact: ChatwootContactDetail = {
            id: 9,
            name: 'shannon804',
            email: 'shannon804@gmail.com',
            additional_attributes: {
                country: '德国',
                city: '柏林',
                created_at_ip: '188.253.117.27',
                browser: { browser_name: 'Safari', browser_version: '26.5', platform_name: 'macOS' },
                browser_language: 'zh',
            },
            custom_attributes: {
                xboard_status: 'no_account',
                xboard_balance: 0,
                xboard_used_gb: 0,
                xboard_subscribe_url: 'https://sub.example.com/abc',
                xboard_synced_at: '2026-06-02T12:00:00Z',
            },
        };
        const text = renderContactDetailMessage(contact, definitions);
        expect(text).toContain('<b>shannon804</b>');
        expect(text).toContain('📧 shannon804@gmail.com');
        expect(text).toContain('德国 · 柏林');
        expect(text).toContain('Safari 26.5 · macOS');
        // 自定义属性用中文显示名
        expect(text).toContain('<b>Xboard 状态</b>：no_account');
        expect(text).toContain('<b>账户余额</b>：¥0');
        expect(text).toContain('<b>已用流量(GB)</b>：0');
        expect(text).toContain('<b>订阅链接</b>：<a href="https://sub.example.com/abc">https://sub.example.com/abc</a>');
        expect(text).toMatch(/<b>Xboard 同步时间<\/b>：\d{4}-\d{2}-\d{2}/);
    });

    it('falls back to raw key when no definition matches', () => {
        const contact: ChatwootContactDetail = {
            id: 1,
            name: 'A',
            custom_attributes: { unknown_field: 'value' },
        };
        const text = renderContactDetailMessage(contact, definitions);
        expect(text).toContain('<code>unknown_field</code>：value');
    });

    it('skips empty custom attribute section when nothing to show', () => {
        const contact: ChatwootContactDetail = { id: 1, name: 'A', email: 'a@b.com' };
        const text = renderContactDetailMessage(contact, definitions);
        expect(text).not.toContain('客户自定义属性');
    });

    it('skips empty or null attribute values', () => {
        const contact: ChatwootContactDetail = {
            id: 1,
            name: 'A',
            custom_attributes: { xboard_status: 'active', xboard_balance: null, xboard_used_gb: '' },
        };
        const text = renderContactDetailMessage(contact, definitions);
        expect(text).toContain('Xboard 状态');
        expect(text).not.toContain('账户余额');
        expect(text).not.toContain('已用流量');
    });
});

describe('markdownToTelegramHtml', () => {
    it('returns empty string for empty input', () => {
        expect(markdownToTelegramHtml('')).toBe('');
    });

    it('escapes HTML special chars before converting', () => {
        expect(markdownToTelegramHtml('<a>&b</a>')).toBe('&lt;a&gt;&amp;b&lt;/a&gt;');
    });

    it('converts bold **text**', () => {
        expect(markdownToTelegramHtml('hello **world** ok'))
            .toBe('hello <b>world</b> ok');
    });

    it('converts links [text](url)', () => {
        expect(markdownToTelegramHtml('see [docs](https://e.com/x?a=1&b=2)'))
            .toBe('see <a href="https://e.com/x?a=1&amp;b=2">docs</a>');
    });

    it('converts inline code', () => {
        expect(markdownToTelegramHtml('use `npm ci` for clean install'))
            .toBe('use <code>npm ci</code> for clean install');
    });

    it('converts fenced code block with language hint', () => {
        const result = markdownToTelegramHtml('```ts\nconst x = 1;\n```');
        expect(result).toBe('<pre>const x = 1;</pre>');
    });

    it('does not interpret markdown inside code blocks', () => {
        const result = markdownToTelegramHtml('`**not bold**`');
        expect(result).toBe('<code>**not bold**</code>');
    });

    it('does not interpret * _ inside link URLs', () => {
        const result = markdownToTelegramHtml('see [a_b](https://e.com/_underscore_*x*)');
        expect(result).toContain('<a href="https://e.com/_underscore_*x*">a_b</a>');
        expect(result).not.toContain('<i>');
    });

    it('handles italic *text* without confusing with bold', () => {
        expect(markdownToTelegramHtml('plain *italic* end'))
            .toBe('plain <i>italic</i> end');
    });

    it('does not break snake_case identifiers with _', () => {
        const result = markdownToTelegramHtml('use foo_bar_baz here');
        expect(result).toBe('use foo_bar_baz here');
    });

    it('converts strikethrough ~~text~~', () => {
        expect(markdownToTelegramHtml('~~old~~ new')).toBe('<s>old</s> new');
    });

    it('handles a real-world Chatwoot AI reply with mixed markdown', () => {
        const input = '您好，我是 **苏菲**！请参考 [使用教程](https://e.com/help)，**节点异常**请看 [此处](https://e.com/x)';
        const result = markdownToTelegramHtml(input);
        expect(result).toContain('<b>苏菲</b>');
        expect(result).toContain('<a href="https://e.com/help">使用教程</a>');
        expect(result).toContain('<b>节点异常</b>');
        expect(result).toContain('<a href="https://e.com/x">此处</a>');
        // 不应留下任何原始 Markdown 标记
        expect(result).not.toContain('**');
        expect(result).not.toContain('](');
    });
});

describe('extractSenderName', () => {
    it('uses sender for incoming, falls back to meta', () => {
        expect(extractSenderName({
            event: 'message_created',
            message_type: 'incoming',
            sender: { name: 'A' },
            conversation: { id: 1, meta: { sender: { name: 'B' } } },
        })).toEqual({ name: 'A', email: '' });

        expect(extractSenderName({
            event: 'message_created',
            message_type: 'incoming',
            conversation: { id: 1, meta: { sender: { name: 'B', email: 'b@x.com' } } },
        })).toEqual({ name: 'B', email: 'b@x.com' });
    });

    it('uses sender for outgoing (agent name) and default 客服 fallback', () => {
        expect(extractSenderName({
            event: 'message_created',
            message_type: 'outgoing',
            sender: { name: '客服小李', email: 'l@x.com' },
            conversation: { id: 1 },
        })).toEqual({ name: '客服小李', email: 'l@x.com' });

        expect(extractSenderName({
            event: 'message_created',
            message_type: 'outgoing',
            conversation: { id: 1 },
        })).toEqual({ name: '客服', email: '' });
    });
});
