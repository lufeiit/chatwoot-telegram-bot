import { describe, expect, it } from 'vitest';
import dotenv from 'dotenv';
import {
    findKeywordAutoReplyForInbox,
    parseKeywordAutoReplyList,
} from '../keyword-auto-reply';

describe('keyword auto reply（兼容旧 JSON 写法）', () => {
    it('parses valid entries and ignores empty entries', () => {
        expect(parseKeywordAutoReplyList('{" 价格 ":"报价说明","空":"","":"忽略"}')).toEqual([
            { keywords: ['价格'], reply: '报价说明', inboxIds: undefined },
        ]);
    });

    it('supports multiple keywords and multiline replies', () => {
        const rules = parseKeywordAutoReplyList(
            '[{"keywords":["Price","cost"],"reply":"Line one\\nLine two"}]',
        );
        expect(findKeywordAutoReplyForInbox('What is the COST?', rules)?.reply).toBe('Line one\nLine two');
    });

    it('supports pipe-separated keywords in shorthand configuration', () => {
        const rules = parseKeywordAutoReplyList(
            '{"在么|在吗|你好|您好|有人":"您好，请描述具体问题。\\n\\n人工客服时间：8:00-21:00。"}',
        );
        expect(rules[0].keywords).toEqual(['在么', '在吗', '你好', '您好', '有人']);
        expect(findKeywordAutoReplyForInbox('你好，请问有人吗？', rules)?.reply)
            .toBe('您好，请描述具体问题。\n\n人工客服时间：8:00-21:00。');
    });

    it('uses the first configured match', () => {
        const rules = parseKeywordAutoReplyList('{"退款":"first","退款进度":"second"}');
        expect(findKeywordAutoReplyForInbox('查询退款进度', rules)?.reply).toBe('first');
    });

    it('rejects non-mapping configuration', () => {
        expect(() => parseKeywordAutoReplyList('"invalid"')).toThrow('规则必须是');
    });
});

describe('单列表写法：默认通用 + 条目上写 inbox', () => {
    const document = `
# 默认规则：不写 inbox = 所有收件箱通用
# 注意：这里的注释不应被当成规则
- keywords: 人工 | 客服
  reply: |
    请等待客服

    人工客服时段：北京时间 9:00 - 21:00

# 需要差异化的规则：写在前面即可优先命中
- keywords: 价格
  inbox: 3
  reply: A 站专属价格说明

- keywords: 价格 | 费用
  inbox: [5, 8]
  reply: B 站价格说明

- keywords: 价格 | 费用
  reply: 请访问导航栏 <<购买>> 页面
`;

    it('parses multiline replies, pipe keywords and inbox field', () => {
        const rules = parseKeywordAutoReplyList(document);
        expect(rules).toHaveLength(4);
        expect(rules[0].keywords).toEqual(['人工', '客服']);
        expect(rules[0].reply).toBe('请等待客服\n\n人工客服时段：北京时间 9:00 - 21:00');
        expect(rules[0].inboxIds).toBeUndefined();
        expect(rules[1].inboxIds).toEqual([3]);
        expect(rules[2].inboxIds).toEqual([5, 8]);
        expect(rules[3].inboxIds).toBeUndefined();
    });

    it('supports literal \\n in block scalars（分行排版，\\n 控制换行）', () => {
        const rules = parseKeywordAutoReplyList([
            '- keywords: 人工',
            '  reply: |',
            '    请等待客服...........\\n\\n\\n',
            '    或者请在群组内联系管理员\\n\\n\\n',
            '    人工客服工作时段：9:00 - 21:00',
        ].join('\n'));
        expect(rules[0].reply).toBe('请等待客服...........\n\n\n或者请在群组内联系管理员\n\n\n人工客服工作时段：9:00 - 21:00');
    });

    it('keeps real newlines when no literal \\n is present', () => {
        const rules = parseKeywordAutoReplyList([
            '- keywords: 人工',
            '  reply: |',
            '    第一行',
            '',
            '    第二行',
        ].join('\n'));
        expect(rules[0].reply).toBe('第一行\n\n第二行');
    });

    it('supports double-quoted replies with \\n escapes（紧凑写法）', () => {
        const rules = parseKeywordAutoReplyList([
            '- keywords: 人工 | 客服',
            '  reply: "第一行\\n\\n第二行"',
            '- keywords: 价格',
            '  inbox: 3',
            '  reply: "专属回复"',
        ].join('\n'));
        expect(rules[0].reply).toBe('第一行\n\n第二行');
        expect(findKeywordAutoReplyForInbox('人工', rules, 1)?.reply).toBe('第一行\n\n第二行');
        expect(rules[1].inboxIds).toEqual([3]);
        expect(findKeywordAutoReplyForInbox('价格', rules, 3)?.reply).toBe('专属回复');
    });

    it('applies inbox-specific rules only to that inbox', () => {
        const rules = parseKeywordAutoReplyList(document);
        expect(findKeywordAutoReplyForInbox('价格多少？', rules, 3)?.reply).toBe('A 站专属价格说明');
        expect(findKeywordAutoReplyForInbox('费用怎么算', rules, 5)?.reply).toBe('B 站价格说明');
        expect(findKeywordAutoReplyForInbox('费用怎么算', rules, 8)?.reply).toBe('B 站价格说明');
        expect(findKeywordAutoReplyForInbox('价格多少？', rules, 9)?.reply).toBe('请访问导航栏 <<购买>> 页面');
    });

    it('uses general rules when inbox id is missing', () => {
        const rules = parseKeywordAutoReplyList(document);
        expect(findKeywordAutoReplyForInbox('价格多少', rules)?.reply).toBe('请访问导航栏 <<购买>> 页面');
        expect(findKeywordAutoReplyForInbox('客服在吗', rules)?.reply).toContain('请等待客服');
    });

    it('follows written order（专属写在前面 => 专属优先）', () => {
        const specificFirst = parseKeywordAutoReplyList(`
- keywords: 价格
  inbox: 3
  reply: 专属
- keywords: 价格
  reply: 通用
`);
        expect(findKeywordAutoReplyForInbox('价格', specificFirst, 3)?.reply).toBe('专属');
        expect(findKeywordAutoReplyForInbox('价格', specificFirst, 9)?.reply).toBe('通用');

        const generalFirst = parseKeywordAutoReplyList(`
- keywords: 价格
  reply: 通用
- keywords: 价格
  inbox: 3
  reply: 专属
`);
        expect(findKeywordAutoReplyForInbox('价格', generalFirst, 3)?.reply).toBe('通用');
    });

    it('accepts keyword map shorthand as general rules', () => {
        expect(parseKeywordAutoReplyList('价格: 回复A')).toEqual([
            { keywords: ['价格'], reply: '回复A', inboxIds: undefined },
        ]);
    });

    it('returns empty list for blank or comment-only content', () => {
        expect(parseKeywordAutoReplyList('')).toEqual([]);
        expect(parseKeywordAutoReplyList('# 只有注释\n')).toEqual([]);
    });

    it('rejects the removed default/inboxes grouping', () => {
        expect(() => parseKeywordAutoReplyList('default:\n  - keywords: x\n    reply: y'))
            .toThrow('不再支持 default / inboxes 分组');
    });
});

describe('KEYWORD_AUTO_REPLIES 写在 .env 中（dotenv 端到端）', () => {
    it('解析单引号包裹的多行 YAML 值（默认通用 + inbox 条目）', () => {
        const envContent = [
            'TELEGRAM_TOKEN=dummy',
            "KEYWORD_AUTO_REPLIES='",
            '# 默认规则（通用）',
            '- keywords: 人工 | 客服',
            '  reply: |',
            '    请等待客服',
            '',
            '    工作时间 9:00-21:00',
            '# 收件箱 3 专属',
            '- keywords: 价格',
            '  inbox: 3',
            '  reply: A 站专属价格',
            "'",
        ].join('\n');

        const parsed = dotenv.parse(envContent);
        const rules = parseKeywordAutoReplyList(parsed.KEYWORD_AUTO_REPLIES);

        expect(rules).toHaveLength(2);
        expect(rules[0].keywords).toEqual(['人工', '客服']);
        expect(rules[0].inboxIds).toBeUndefined();
        expect(rules[1].inboxIds).toEqual([3]);
        expect(findKeywordAutoReplyForInbox('价格多少', rules, 3)?.reply).toBe('A 站专属价格');
        expect(findKeywordAutoReplyForInbox('价格多少', rules, 9)?.reply).toBeUndefined();
        expect(findKeywordAutoReplyForInbox('客服在吗', rules, 3)?.reply).toBe('请等待客服\n\n工作时间 9:00-21:00');
    });

    it('仍然兼容旧的单行 JSON 写法', () => {
        const parsed = dotenv.parse('KEYWORD_AUTO_REPLIES=\'{"价格":"旧格式回复"}\'');
        const rules = parseKeywordAutoReplyList(parsed.KEYWORD_AUTO_REPLIES);
        expect(findKeywordAutoReplyForInbox('价格', rules, 1)?.reply).toBe('旧格式回复');
    });
});
