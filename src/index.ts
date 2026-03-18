import http from 'http';
import { app } from './server';
import { bot } from './bot';
import { config } from './config';
import { initDb as initDatabase } from './database';
import { createLogger } from './logger';

const log = createLogger('main');
const PORT = config.port;

async function start() {
    initDatabase();
    log.info('Database initialized');

    log.info('Starting Telegram bot...');
    bot.launch({ dropPendingUpdates: true }).then(() => {
        log.info('Telegram bot started (polling mode)');
    }).catch((err) => {
        log.error('Failed to start Telegram bot', { error: String(err) });
    });

    const server = http.createServer(app);
    server.listen(PORT, () => {
        log.info(`Webhook server running on port ${PORT}`);
    });

    const SHUTDOWN_TIMEOUT_MS = 10_000;

    function gracefulShutdown(signal: string) {
        log.info(`Received ${signal}, shutting down gracefully...`);

        bot.stop(signal);

        server.close(() => {
            log.info('HTTP server closed');
            process.exit(0);
        });

        setTimeout(() => {
            log.warn('Graceful shutdown timed out, forcing exit');
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS).unref();
    }

    process.once('SIGINT', () => gracefulShutdown('SIGINT'));
    process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

start();
