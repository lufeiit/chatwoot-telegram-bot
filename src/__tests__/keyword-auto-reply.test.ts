import { describe, expect, it } from 'vitest';
import { findKeywordAutoReply, parseKeywordAutoReplies } from '../keyword-auto-reply';

describe('keyword auto reply', () => {
    it('parses valid entries and ignores empty entries', () => {
        expect(parseKeywordAutoReplies('{" 价格 ":"报价说明","空":"","":"忽略"}')).toEqual([
            { keywords: ['价格'], reply: '报价说明' },
        ]);
    });

    it('supports multiple keywords and multiline replies', () => {
        const replies = parseKeywordAutoReplies(
            '[{"keywords":["Price","cost"],"reply":"Line one\\nLine two"}]',
        );
        expect(findKeywordAutoReply('What is the COST?', replies)?.reply).toBe('Line one\nLine two');
    });

    it('supports pipe-separated keywords in shorthand configuration', () => {
        const replies = parseKeywordAutoReplies(
            '{"在么|在吗|你好|您好|有人":"您好，请描述具体问题。\\n\\n人工客服时间：8:00-21:00。"}',
        );
        expect(replies[0].keywords).toEqual(['在么', '在吗', '你好', '您好', '有人']);
        expect(findKeywordAutoReply('你好，请问有人吗？', replies)?.reply)
            .toBe('您好，请描述具体问题。\n\n人工客服时间：8:00-21:00。');
    });

    it('uses the first configured match', () => {
        const replies = parseKeywordAutoReplies('{"退款":"first","退款进度":"second"}');
        expect(findKeywordAutoReply('查询退款进度', replies)?.reply).toBe('first');
    });

    it('rejects non-object configuration', () => {
        expect(() => parseKeywordAutoReplies('"invalid"')).toThrow('must be a JSON object or array');
    });
});
