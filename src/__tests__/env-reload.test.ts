import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// 必须在 import config 之前准备必需环境变量（config 模块加载时会校验，缺失会 process.exit）
process.env.TELEGRAM_TOKEN = 'test-token';
process.env.TELEGRAM_ADMIN_ID = '1';
process.env.CHATWOOT_ACCESS_TOKEN = 'test-token';
process.env.CHATWOOT_ACCOUNT_ID = '1';
process.env.KEYWORD_AUTO_REPLIES = '';

type ConfigModule = typeof import('../config');
let configModule: ConfigModule;

beforeAll(async () => {
    configModule = await import('../config');
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-reload-'));
const envFile = path.join(tmpDir, '.env');

function writeEnv(lines: string[]) {
    fs.writeFileSync(envFile, lines.join('\n'));
}

describe('KEYWORD_AUTO_REPLIES 热加载', () => {
    it('从 .env 文件重新加载规则', () => {
        writeEnv([
            "KEYWORD_AUTO_REPLIES='",
            '- keywords: 人工',
            '  reply: "请等待客服"',
            "'",
        ]);

        const result = configModule.reloadKeywordAutoReplies(envFile);

        expect(result.changed).toBe(true);
        expect(result.rules).toBe(1);
        expect(configModule.config.autoReplies[0].keywords).toEqual(['人工']);
        // 兼容字段同步更新
        expect(configModule.config.keywordAutoReplies).toBe(configModule.config.autoReplies);
    });

    it('内容变化后可再次加载（含 inbox 限定）', () => {
        writeEnv([
            "KEYWORD_AUTO_REPLIES='",
            '- keywords: 价格',
            '  inbox: 3',
            '  reply: "A 站专属"',
            "'",
        ]);

        const result = configModule.reloadKeywordAutoReplies(envFile);

        expect(result.changed).toBe(true);
        expect(result.rules).toBe(1);
        expect(result.inboxSpecific).toBe(1);
        expect(configModule.config.autoReplies[0].inboxIds).toEqual([3]);
    });

    it('规则非法时保留旧规则并返回错误（服务不崩溃）', () => {
        writeEnv(["KEYWORD_AUTO_REPLIES='", 'default:', '  - keywords: x', "    reply: y'"]);

        const before = configModule.config.autoReplies;
        const result = configModule.reloadKeywordAutoReplies(envFile);

        expect(result.changed).toBe(false);
        expect(result.error).toBeTruthy();
        expect(configModule.config.autoReplies).toBe(before);
    });

    it('.env 不存在时返回错误（并提示需要挂载）', () => {
        const result = configModule.reloadKeywordAutoReplies(path.join(tmpDir, 'missing.env'));

        expect(result.changed).toBe(false);
        expect(result.error).toContain('不存在');
    });

    it('KEYWORD_AUTO_REPLIES 留空时得到空规则（不报错）', () => {
        writeEnv(['KEYWORD_AUTO_REPLIES=']);

        const result = configModule.reloadKeywordAutoReplies(envFile);

        expect(result.changed).toBe(true);
        expect(result.rules).toBe(0);
        expect(configModule.config.autoReplies).toEqual([]);
    });
});
