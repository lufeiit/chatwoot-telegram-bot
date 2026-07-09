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
    buildContactCardFromApi,
    languageLabel,
    formatReferer,
    __test__,
} from '../formatters';
import type {
    ChatwootMessageEvent,
    ChatwootContactDetail,
    ChatwootConversation,
    CustomAttributeDefinition,
} from '../types';

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
        // 渠道 + 收件箱
        expect(text).toContain('网页咨询');
        expect(text).toContain('官网');
        // 持久位置
        expect(text).toContain('中国 · 上海');
        // 会话信息块
        expect(text).toContain('🕒 <b>发起于</b>：');
        expect(text).toContain('🗣️ <b>浏览器语言</b>：简体中文'); // zh-CN → 简体中文
        expect(text).toContain('🔗 <b>启动自</b>：');
        expect(text).toContain('🌐 <b>浏览器</b>：Chrome 138');
        expect(text).toContain('💻 <b>操作系统</b>：macOS'); // 没有 version 时只显示 name
        // URL & 被转义；hostname 作锚文本
        expect(text).toContain('href="https://e.com/p?x=1&amp;y=2"');
        expect(text).toContain('>e.com</a>');
    });

    it('skips missing fields', () => {
        const text = renderContactCard({ name: '匿名联系人' }, 1);
        expect(text).toContain('匿名联系人');
        expect(text).not.toContain('📧');
        expect(text).not.toContain('📞');
        // 没有 browser 时无浏览器行；但卡片有 💬 提示行，所以不能用 💻 来反向检测
        expect(text).not.toContain('🌐 <b>浏览器</b>');
        expect(text).not.toContain('💻 <b>操作系统</b>');
        expect(text).not.toContain('🕒 <b>发起于</b>');
    });

    it('escapes HTML in name to prevent injection', () => {
        const text = renderContactCard({ name: '<script>x</script>' }, 1);
        expect(text).toContain('&lt;script&gt;x&lt;/script&gt;');
        expect(text).not.toContain('<script>');
    });

    it('renders custom attributes inline with Chinese display names when definitions are provided', () => {
        const definitions: CustomAttributeDefinition[] = [
            { id: 1, attribute_display_name: 'Xboard 套餐', attribute_display_type: 'text', attribute_key: 'xboard_plan', attribute_model: 'contact_attribute' },
            { id: 2, attribute_display_name: '账户余额', attribute_display_type: 'currency', attribute_key: 'xboard_balance', attribute_model: 'contact_attribute' },
            { id: 3, attribute_display_name: '已用流量(GB)', attribute_display_type: 'number', attribute_key: 'xboard_used_gb', attribute_model: 'contact_attribute' },
        ];
        const text = renderContactCard({
            name: 'shannon8804',
            customAttributes: {
                xboard_plan: '日本星链家宽',
                xboard_balance: 0,
                xboard_used_gb: 102.17,
            },
        }, 2294, definitions);
        expect(text).toContain('客户自定义属性');
        expect(text).toContain('<b>Xboard 套餐</b>：日本星链家宽');
        expect(text).toContain('<b>账户余额</b>：¥0');
        expect(text).toContain('<b>已用流量(GB)</b>：102.17');
        // 不应再有旧版「📊 自定义属性 N 项（点击下方...按钮查看）」的占位提示
        expect(text).not.toContain('自定义属性 3 项');
        expect(text).not.toContain('按钮查看');
    });

    it('falls back to key names when definitions are unavailable', () => {
        const text = renderContactCard({
            name: 'A',
            customAttributes: { unknown_key: 'value' },
        }, 1);
        // 没传 definitions → 降级用 <code>键名</code>: 值
        expect(text).toContain('<code>unknown_key</code>：value');
    });

    it('hides stale attributes that are missing from Chatwoot definitions', () => {
        const definitions: CustomAttributeDefinition[] = [
            { id: 1, attribute_display_name: '已使用流量', attribute_display_type: 'text', attribute_key: 'used_traffic', attribute_model: 'contact_attribute' },
        ];
        const text = renderContactCard({
            name: 'A',
            customAttributes: {
                used_traffic: '0.00 GB',
                'used_trahttps://github.com/Shannon-x/chatwoot-telegram-botffic': '0.00 GB',
            },
        }, 1, definitions);

        expect(text).toContain('<b>已使用流量</b>：0.00 GB');
        expect(text).not.toContain('Shannon-x');
    });

    it('keeps optional upload and download attributes when definitions exist', () => {
        const definitions: CustomAttributeDefinition[] = [
            { id: 1, attribute_display_name: '上传流量', attribute_display_type: 'text', attribute_key: 'v2board_upload', attribute_model: 'contact_attribute' },
            { id: 2, attribute_display_name: '下载流量', attribute_display_type: 'text', attribute_key: 'v2board_download', attribute_model: 'contact_attribute' },
        ];
        const text = renderContactCard({
            name: 'A',
            customAttributes: {
                v2board_upload: '1.00 GB',
                v2board_download: '2.00 GB',
            },
        }, 1, definitions);

        expect(text).toContain('<b>上传流量</b>：1.00 GB');
        expect(text).toContain('<b>下载流量</b>：2.00 GB');
    });

    it('skips empty custom attribute values', () => {
        const definitions: CustomAttributeDefinition[] = [
            { id: 1, attribute_display_name: 'Plan', attribute_display_type: 'text', attribute_key: 'plan', attribute_model: 'contact_attribute' },
            { id: 2, attribute_display_name: 'Balance', attribute_display_type: 'number', attribute_key: 'balance', attribute_model: 'contact_attribute' },
        ];
        const text = renderContactCard({
            name: 'A',
            customAttributes: { plan: 'pro', balance: null, empty_field: '' },
        }, 1, definitions);
        expect(text).toContain('<b>Plan</b>：pro');
        expect(text).not.toContain('Balance');
        expect(text).not.toContain('empty_field');
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

describe('languageLabel', () => {
    it('maps zh / zh-CN / zh_CN / zh-cn to Chinese variants', () => {
        expect(languageLabel('zh')).toBe('中文');
        expect(languageLabel('zh-CN')).toBe('简体中文');
        expect(languageLabel('zh_CN')).toBe('简体中文'); // underscore normalize
        expect(languageLabel('zh-TW')).toBe('繁体中文');
    });
    it('maps en variants', () => {
        expect(languageLabel('en')).toBe('英文');
        expect(languageLabel('en-US')).toBe('英文（美）');
        expect(languageLabel('en-GB')).toBe('英文（英）');
    });
    it('maps other common languages', () => {
        expect(languageLabel('ja')).toBe('日文');
        expect(languageLabel('ko')).toBe('韩文');
        expect(languageLabel('ru')).toBe('俄文');
        expect(languageLabel('vi')).toBe('越南文');
    });
    it('falls back to primary language for unknown region', () => {
        // fr-XX 没在字典里，但 fr 在 → 应该映射成法文
        expect(languageLabel('fr-XX')).toBe('法文');
    });
    it('returns raw code for unknown language', () => {
        expect(languageLabel('xx-YY')).toBe('xx-YY');
        expect(languageLabel('klingon')).toBe('klingon');
    });
    it('returns empty for empty input', () => {
        expect(languageLabel('')).toBe('');
        expect(languageLabel(undefined)).toBe('');
        expect(languageLabel(null)).toBe('');
    });
});

describe('formatReferer', () => {
    it('renders hostname as anchor text, full URL as href', () => {
        expect(formatReferer('https://www.sufe.pro/#/shop'))
            .toBe('<a href="https://www.sufe.pro/#/shop">www.sufe.pro</a>');
    });
    it('escapes & in URL', () => {
        expect(formatReferer('https://e.com/?a=1&b=2'))
            .toBe('<a href="https://e.com/?a=1&amp;b=2">e.com</a>');
    });
    it('rejects javascript: scheme (XSS prevention)', () => {
        expect(formatReferer('javascript:alert(1)')).toBe('javascript:alert(1)');
        expect(formatReferer('javascript:alert(1)')).not.toContain('<a');
    });
    it('rejects data: and about: schemes', () => {
        expect(formatReferer('data:text/html,<h1>x</h1>')).not.toContain('<a');
        expect(formatReferer('about:blank')).not.toContain('<a');
    });
    it('falls back to escaped raw text on parse failure', () => {
        expect(formatReferer('not a url')).toBe('not a url');
    });
    it('returns empty for empty input', () => {
        expect(formatReferer('')).toBe('');
        expect(formatReferer(undefined)).toBe('');
    });
});

describe('joinBrowser / joinOs', () => {
    const { joinBrowser, joinOs } = __test__;

    it('joinBrowser: name + version', () => {
        expect(joinBrowser('Chrome', '131.0.6778.200')).toBe('Chrome 131.0.6778.200');
    });
    it('joinBrowser: name only when version missing', () => {
        expect(joinBrowser('Safari', undefined)).toBe('Safari');
    });
    it('joinBrowser: empty when name missing', () => {
        expect(joinBrowser(undefined, '1.0')).toBe('');
    });
    it('joinOs: platform name + version', () => {
        expect(joinOs('Android', '16', 'SM-G991B')).toBe('Android 16');
    });
    it('joinOs: falls back to device_name when no platform_name', () => {
        expect(joinOs(undefined, undefined, 'Pixel 7')).toBe('Pixel 7');
    });
    it('joinOs: empty when nothing available', () => {
        expect(joinOs(undefined, undefined, undefined)).toBe('');
    });
});

describe('extractContactCard — conversation-level priority', () => {
    it('prefers conversation.additional_attributes for browser / language / referer / initiated_at / platform_version', () => {
        const event: ChatwootMessageEvent = {
            event: 'message_created',
            message_type: 'incoming',
            sender: {
                id: 99,
                type: 'contact',
                name: 'A',
                additional_attributes: {
                    // 旧的 contact-level 数据（应被会话级覆盖）
                    browser: { browser_name: 'OldChrome', browser_version: '50', platform_name: 'Windows', platform_version: '7' },
                    browser_language: 'en',
                    referer: 'https://old.example.com',
                    initiated_at: { timestamp: 1000 },
                    // 持久属性
                    country: '美国',
                    city: '旧金山',
                    country_code: 'US',
                    created_at_ip: '1.1.1.1',
                },
            },
            conversation: {
                id: 1,
                additional_attributes: {
                    // 当前会话数据（应优先）
                    browser: { browser_name: 'Chrome', browser_version: '131.0', platform_name: 'Android', platform_version: '16' },
                    browser_language: 'zh-CN',
                    referer: 'https://www.sufe.pro/#/shop',
                    initiated_at: { timestamp: 1717286400 },
                },
            },
        };
        const card = extractContactCard(event);
        // 会话级覆盖
        expect(card.browserName).toBe('Chrome');
        expect(card.browserVersion).toBe('131.0');
        expect(card.platformName).toBe('Android');
        expect(card.platformVersion).toBe('16');
        expect(card.browserLanguage).toBe('zh-CN');
        expect(card.referer).toBe('https://www.sufe.pro/#/shop');
        expect(card.initiatedAt).toBe(1717286400);
        // 持久属性来自 contact
        expect(card.country).toBe('美国');
        expect(card.city).toBe('旧金山');
        expect(card.countryCode).toBe('US');
        expect(card.createdAtIp).toBe('1.1.1.1'); // 仅 contact 有时
    });

    it('falls back to contact-level when conversation lacks the field', () => {
        const event: ChatwootMessageEvent = {
            event: 'message_created',
            message_type: 'incoming',
            sender: {
                id: 99,
                type: 'contact',
                name: 'A',
                additional_attributes: {
                    browser: { browser_name: 'Safari', browser_version: '17' },
                    browser_language: 'ja',
                    country: '日本',
                },
            },
            conversation: {
                id: 1,
                additional_attributes: {},
            },
        };
        const card = extractContactCard(event);
        expect(card.browserName).toBe('Safari');
        expect(card.browserVersion).toBe('17');
        expect(card.browserLanguage).toBe('ja');
        expect(card.country).toBe('日本');
    });

    it('country/city/country_code are NEVER taken from conversation', () => {
        // 即使 conv.additional_attributes 上有这些（一些罕见集成），也只读 contact 的
        const event: ChatwootMessageEvent = {
            event: 'message_created',
            message_type: 'incoming',
            sender: {
                id: 99,
                type: 'contact',
                name: 'A',
                additional_attributes: { country: '中国', city: '北京' },
            },
            conversation: {
                id: 1,
                additional_attributes: { country: 'US', city: 'NYC' } as Record<string, unknown>,
            },
        };
        const card = extractContactCard(event);
        expect(card.country).toBe('中国');
        expect(card.city).toBe('北京');
    });

    it('treats conv-level empty string as "no value" so contact-level non-empty wins', () => {
        // pickFirst 不应让 conv 上的空 referer 把 contact 上的真实 URL 挤掉
        const event: ChatwootMessageEvent = {
            event: 'message_created',
            message_type: 'incoming',
            sender: {
                id: 99,
                type: 'contact',
                name: 'A',
                additional_attributes: {
                    referer: 'https://valid-old.example.com',
                    browser_language: 'fr',
                },
            },
            conversation: {
                id: 1,
                additional_attributes: { referer: '', browser_language: '' },
            },
        };
        const card = extractContactCard(event);
        expect(card.referer).toBe('https://valid-old.example.com');
        expect(card.browserLanguage).toBe('fr');
    });

    it('treats conv-level empty browser object as "no value"', () => {
        const event: ChatwootMessageEvent = {
            event: 'message_created',
            message_type: 'incoming',
            sender: {
                id: 99,
                type: 'contact',
                name: 'A',
                additional_attributes: {
                    browser: { browser_name: 'Firefox', browser_version: '120' },
                },
            },
            conversation: {
                id: 1,
                additional_attributes: { browser: {} }, // empty object should NOT mask contact
            },
        };
        const card = extractContactCard(event);
        expect(card.browserName).toBe('Firefox');
    });

    it('prefers updated_at_ip over created_at_ip when both exist', () => {
        const event: ChatwootMessageEvent = {
            event: 'message_created',
            message_type: 'incoming',
            sender: {
                id: 99,
                type: 'contact',
                name: 'A',
                additional_attributes: {
                    created_at_ip: '1.1.1.1',
                    updated_at_ip: '2.2.2.2',
                } as Record<string, unknown>,
            },
            conversation: { id: 1 },
        };
        const card = extractContactCard(event);
        expect(card.createdAtIp).toBe('2.2.2.2'); // updated_at_ip wins
    });
});

describe('renderContactCard — conversation info layout', () => {
    it('renders all session fields in Chatwoot panel order', () => {
        const text = renderContactCard({
            name: '2578910587',
            email: '2578910587@qq.com',
            channel: 'Channel::WebWidget',
            inboxName: '苏菲家宽',
            initiatedAt: 1717286400,
            browserLanguage: 'zh',
            referer: 'https://www.sufe.pro/#/shop',
            browserName: 'Chrome',
            browserVersion: '131.0.6778.200',
            platformName: 'Android',
            platformVersion: '16',
            createdAtIp: '240e:476:4c9:16d0:64d3:d4ff:fed5:e259',
        }, 2295);

        // 顺序：发起于 → 浏览器语言 → 启动自 → 浏览器 → IP → 操作系统
        const lines = text.split('\n');
        const idx = {
            initiated: lines.findIndex(l => l.includes('发起于')),
            lang: lines.findIndex(l => l.includes('浏览器语言')),
            from: lines.findIndex(l => l.includes('启动自')),
            browser: lines.findIndex(l => l.includes('浏览器</b>')),
            ip: lines.findIndex(l => l.includes('IP</b>')),
            os: lines.findIndex(l => l.includes('操作系统')),
        };
        expect(idx.initiated).toBeGreaterThan(-1);
        expect(idx.lang).toBeGreaterThan(idx.initiated);
        expect(idx.from).toBeGreaterThan(idx.lang);
        expect(idx.browser).toBeGreaterThan(idx.from);
        expect(idx.ip).toBeGreaterThan(idx.browser);
        expect(idx.os).toBeGreaterThan(idx.ip);

        // 内容
        expect(text).toContain('🗣️ <b>浏览器语言</b>：中文');
        expect(text).toContain('🌐 <b>浏览器</b>：Chrome 131.0.6778.200');
        expect(text).toContain('💻 <b>操作系统</b>：Android 16');
        expect(text).toContain('📡 <b>IP</b>：240e:476:4c9:16d0:64d3:d4ff:fed5:e259');
        expect(text).toContain('<a href="https://www.sufe.pro/#/shop">www.sufe.pro</a>');
    });

    it('omits each line independently when its field is missing', () => {
        const text = renderContactCard({
            name: 'A',
            channel: 'Channel::Api',
            initiatedAt: 1717286400,
            // 故意省略 browser_language / referer / browser / ip / os
        }, 1);
        expect(text).toContain('🕒 <b>发起于</b>');
        expect(text).not.toContain('🗣️');
        expect(text).not.toContain('🔗 <b>启动自</b>');
        expect(text).not.toContain('🌐 <b>浏览器</b>');
        expect(text).not.toContain('📡 <b>IP</b>');
        expect(text).not.toContain('💻 <b>操作系统</b>');
    });

    it('falls back to platform name only when version missing; uses device_name when platform missing', () => {
        const a = renderContactCard({
            name: 'A', channel: 'X', platformName: 'macOS',
        }, 1);
        expect(a).toContain('💻 <b>操作系统</b>：macOS');

        const b = renderContactCard({
            name: 'B', channel: 'X', deviceName: 'iPad',
        }, 2);
        expect(b).toContain('💻 <b>操作系统</b>：iPad');
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
        // 详情消息按新版面，浏览器和操作系统分别两行
        expect(text).toContain('🌐 <b>浏览器</b>：Safari 26.5');
        expect(text).toContain('💻 <b>操作系统</b>：macOS');
        // 自定义属性用中文显示名
        expect(text).toContain('<b>Xboard 状态</b>：no_account');
        expect(text).toContain('<b>账户余额</b>：¥0');
        expect(text).toContain('<b>已用流量(GB)</b>：0');
        expect(text).toContain('<b>订阅链接</b>：<a href="https://sub.example.com/abc">https://sub.example.com/abc</a>');
        expect(text).toMatch(/<b>Xboard 同步时间<\/b>：\d{4}-\d{2}-\d{2}/);
    });

    it('hides stale raw keys when definitions are available', () => {
        const contact: ChatwootContactDetail = {
            id: 1,
            name: 'A',
            custom_attributes: { unknown_field: 'value' },
        };
        const text = renderContactDetailMessage(contact, definitions);
        expect(text).not.toContain('unknown_field');
        expect(text).not.toContain('客户自定义属性');
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

describe('formatTimestamp — 固定北京时间(UTC+8)', () => {
    const fmt = __test__.formatTimestamp;
    it('把 UTC 时间戳按 +8 小时渲染成北京时间', () => {
        // 2024-06-02 00:00:00 UTC → 北京 08:00
        expect(fmt(Date.UTC(2024, 5, 2, 0, 0, 0) / 1000)).toBe('2024-06-02 08:00');
    });
    it('跨日：UTC 当天 20:00 → 北京次日 04:00', () => {
        expect(fmt(Date.UTC(2026, 5, 5, 20, 0, 0) / 1000)).toBe('2026-06-06 04:00');
    });
});

describe('buildContactCardFromApi — 刷新视图补齐会话维度字段', () => {
    // 模拟「刷新最新资料」时两路 API 的返回（用户实际场景的数据）
    const conversation: ChatwootConversation = {
        id: 12345,
        channel: 'Channel::WebWidget',
        contact_inbox: { source_id: 'cbac2a42-a3bc-418e-ac60-e1b2eb95a0d6' },
        additional_attributes: {
            browser: {
                browser_name: 'Chrome',
                browser_version: '148.0.0.0',
                platform_name: 'Windows',
                platform_version: '10.0',
            },
            browser_language: 'zh',
            referer: 'https://www.sufe.pro',
            created_at_ip: '43.212.202.45',
            initiated_at: { timestamp: '2026-06-06T02:52:00Z' },
        },
        labels: [],
    };
    const contact: ChatwootContactDetail = {
        id: 9,
        name: '苏菲',
        email: '752073964@qq.com',
        // contact 自身不带会话维度信息，靠 conversation 补齐
        additional_attributes: {},
        custom_attributes: {},
        contact_inboxes: [
            {
                source_id: 'cbac2a42-a3bc-418e-ac60-e1b2eb95a0d6',
                inbox: { id: 3, name: '苏菲家宽', channel_type: 'Channel::WebWidget' },
            },
        ],
    };

    it('合并会话 + 联系人，渲染出全部 9 项字段', () => {
        const info = buildContactCardFromApi(conversation, contact);
        const text = renderContactCard(info, conversation.id, [], { footer: false });

        expect(text).toContain('📧 752073964@qq.com');
        expect(text).toContain('🔑 cbac2a42-a3bc-418e-ac60-e1b2eb95a0d6');
        expect(text).toContain('📥 🌐 网页咨询 · 苏菲家宽');
        // 发起时间固定按北京时间（UTC+8）显示：02:52 UTC → 10:52 北京，结果与服务器时区无关
        expect(text).toContain('🕒 <b>发起于</b>：2026-06-06 10:52');
        expect(text).toContain('🗣️ <b>浏览器语言</b>：中文');
        expect(text).toContain('🔗 <b>启动自</b>：<a href="https://www.sufe.pro">www.sufe.pro</a>');
        expect(text).toContain('🌐 <b>浏览器</b>：Chrome 148.0.0.0');
        expect(text).toContain('📡 <b>IP</b>：43.212.202.45');
        expect(text).toContain('💻 <b>操作系统</b>：Windows 10.0');
        // 刷新视图无按钮，不应带「点击下方按钮」footer
        expect(text).not.toContain('点击下方按钮');
    });

    it('渠道从匹配的收件箱回退取 channel_type（conversation.channel 缺失时仍正确）', () => {
        const convNoChannel: ChatwootConversation = { ...conversation, channel: undefined };
        const info = buildContactCardFromApi(convNoChannel, contact);
        expect(info.channel).toBe('Channel::WebWidget');
        expect(info.inboxName).toBe('苏菲家宽');
    });

    it('联系人级属性（邮箱/自定义属性）以最新 getContact 为准', () => {
        const contactWithCustom: ChatwootContactDetail = {
            ...contact,
            custom_attributes: { xboard_balance: 42 },
        };
        const info = buildContactCardFromApi(conversation, contactWithCustom);
        expect(info.email).toBe('752073964@qq.com');
        expect(info.customAttributes).toEqual({ xboard_balance: 42 });
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
