import http from 'http';
import { app, handleMessageCreated, handleConversationStatusChanged, isDuplicateEvent } from './server';
import { bot } from './bot';
import './bot'; // 确保 bot handlers 注册（callback router 在 import 时挂载）
import { config } from './config';
import { initDb as initDatabase, closeDb, getPollState, savePollState } from './database';
import { ChatwootPoller } from './poller';
import { listRecentConversations, listConversationMessages } from './chatwoot';
import { createLogger, closeLogger } from './logger';
import { startEnvWatcher } from './env-watcher';

const log = createLogger('main');
const PORT = config.port;

async function start() {
    initDatabase();
    log.info('Database initialized');

    // 在 launch 之前先验证 token：bot.launch() 在 polling 模式下永远不 resolve，
    // 错误只会通过抛出方式向上传播（不会触发 .catch 链）。
    let botInfo: { username: string; id: number };
    try {
        const me = await bot.telegram.getMe();
        botInfo = { username: me.username, id: me.id };
        log.info('Telegram bot identified', botInfo);
    } catch (err) {
        log.error('Failed to identify Telegram bot (token invalid?)', { error: String(err) });
        process.exit(1);
    }

    log.info('Starting Telegram bot...', {
        dropPendingUpdates: config.telegramDropPendingUpdates,
    });
    // launch() 在 polling 模式下持续运行，不应 await
    bot.launch({ dropPendingUpdates: config.telegramDropPendingUpdates }).catch((err) => {
        log.error('Bot polling crashed', { error: String(err) });
        process.exit(1);
    });

    const server = http.createServer(app);
    server.listen(PORT, () => {
        log.info(`Webhook server running on port ${PORT}`);
    });

    // ============ 轮询模式（无 Webhook 时可选） ============
    let poller: ChatwootPoller | undefined;
    if (config.chatwootSyncMode !== 'webhook') {
        poller = new ChatwootPoller(
            {
                accountId: Number(config.chatwootAccountId),
                listConversations: () => listRecentConversations(),
                listMessages: (conversationId, after) => listConversationMessages(conversationId, { after }),
                getState: getPollState,
                saveState: savePollState,
                handleMessage: handleMessageCreated,
                handleStatusChange: handleConversationStatusChanged,
                isDuplicate: isDuplicateEvent,
            },
            {
                intervalSeconds: config.pollIntervalSeconds,
                maxConversations: config.pollMaxConversations,
                forwardHistory: config.pollForwardHistory,
            },
        );
        poller.start();
        log.info('Chatwoot sync mode', {
            mode: config.chatwootSyncMode,
            intervalSeconds: config.pollIntervalSeconds,
            maxConversations: config.pollMaxConversations,
        });
    } else {
        log.info('Chatwoot sync mode', { mode: 'webhook' });
    }

    // ============ .env 关键词规则热加载（修改 .env 无需重启） ============
    const stopEnvWatcher = startEnvWatcher();

    const SHUTDOWN_TIMEOUT_MS = 10_000;
    let shuttingDown = false;

    async function gracefulShutdown(signal: string) {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info(`Received ${signal}, shutting down gracefully...`);

        const forceExit = setTimeout(() => {
            log.warn('Graceful shutdown timed out, forcing exit');
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS);
        forceExit.unref();

        bot.stop(signal);
        poller?.stop();
        stopEnvWatcher();

        await new Promise<void>((resolve) => {
            server.close(() => {
                log.info('HTTP server closed');
                resolve();
            });
        });

        closeDb();
        await closeLogger();
        process.exit(0);
    }

    process.once('SIGINT', () => { void gracefulShutdown('SIGINT'); });
    process.once('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
}

start().catch((err) => {
    log.error('Fatal error during startup', { error: String(err) });
    process.exit(1);
});
