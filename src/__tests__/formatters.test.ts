import { describe, it, expect } from 'vitest';
import {
    escapeHtml,
    extractContactCard,
    renderContactCard,
    renderForwardedMessage,
    extractSenderName,
    __test__,
} from '../formatters';
import type { ChatwootMessageEvent } from '../types';

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
    it('escapes Markdown-special characters safely', () => {
        const text = renderForwardedMessage({
            messageType: 'incoming',
            senderName: '张_三*',
            senderEmail: 'a@b.com',
            content: 'hello *world* `code` _under_ <tag>',
            attachmentCount: 2,
        });
        // Markdown 特殊字符不再触发解析错误（用 HTML 模式）
        expect(text).toContain('张_三*');
        expect(text).toContain('hello *world* `code` _under_ &lt;tag&gt;');
        expect(text).toContain('📎 附件：2 个');
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
