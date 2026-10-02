import fs from 'fs';
import { config, reloadKeywordAutoReplies } from './config';
import { createLogger } from './logger';

const log = createLogger('env-watcher');

/**
 * 监听 .env 变化并热加载关键词规则（其余配置仍需重启容器生效）。
 *
 * 触发方式：
 *   · 定时检测文件 mtime（默认每 5 秒，`ENV_RELOAD_INTERVAL_SECONDS` 可调，0 = 关闭）
 *   · 发送 SIGHUP 立即重载：`docker compose kill -s HUP bot`
 *
 * 前提：docker-compose 里把 .env 挂载进容器（`- ./.env:/app/.env:ro`）；
 *      未挂载时静默跳过（不报错、不影响服务）。
 *
 * @returns 停止监听的函数（供优雅关闭时调用）
 */
export function startEnvWatcher(): () => void {
    const filePath = config.envFilePath;
    const intervalSeconds = config.envReloadIntervalSeconds;

    let lastMtimeMs = readMtimeMs(filePath);

    const check = (trigger: 'interval' | 'SIGHUP') => {
        const mtimeMs = readMtimeMs(filePath);
        if (mtimeMs == null) return; // 未挂载 / 不可读 → 静默跳过
        if (mtimeMs === lastMtimeMs) return;

        lastMtimeMs = mtimeMs;
        const result = reloadKeywordAutoReplies(filePath);

        if (result.error) {
            log.error('关键词规则热加载失败，已保留原规则', { trigger, error: result.error });
            return;
        }
        if (result.changed) {
            log.info('关键词规则已热加载（无需重启）', {
                trigger,
                rules: result.rules,
                inboxSpecific: result.inboxSpecific,
            });
        }
    };

    const onHup = () => check('SIGHUP');
    process.on('SIGHUP', onHup);

    let timer: ReturnType<typeof setInterval> | undefined;
    if (intervalSeconds > 0) {
        timer = setInterval(() => check('interval'), intervalSeconds * 1000);
        timer.unref?.();
    }

    log.info('关键词规则热加载已启用', {
        file: filePath,
        intervalSeconds: intervalSeconds > 0 ? intervalSeconds : 'disabled',
        signal: 'SIGHUP',
    });

    return () => {
        if (timer) clearInterval(timer);
        process.off('SIGHUP', onHup);
    };
}

function readMtimeMs(filePath: string): number | null {
    try {
        const stat = fs.statSync(filePath);
        return stat.isFile() ? stat.mtimeMs : null;
    } catch {
        return null;
    }
}
