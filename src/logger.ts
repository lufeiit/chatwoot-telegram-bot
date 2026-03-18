export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]: 'INFO',
    [LogLevel.WARN]: 'WARN',
    [LogLevel.ERROR]: 'ERROR',
};

function parseLevel(raw: string): LogLevel {
    switch (raw.toLowerCase()) {
        case 'debug': return LogLevel.DEBUG;
        case 'warn': return LogLevel.WARN;
        case 'error': return LogLevel.ERROR;
        default: return LogLevel.INFO;
    }
}

const currentLevel = parseLevel(process.env.LOG_LEVEL || 'info');
const isProduction = process.env.NODE_ENV === 'production';

function emit(level: LogLevel, module: string, msg: string, meta?: Record<string, unknown>) {
    if (level < currentLevel) return;

    const label = LEVEL_LABELS[level];
    const ts = new Date().toISOString();

    if (isProduction) {
        const obj: Record<string, unknown> = { ts, level: label, module, msg };
        if (meta && Object.keys(meta).length > 0) Object.assign(obj, meta);
        const line = JSON.stringify(obj);
        if (level >= LogLevel.ERROR) process.stderr.write(line + '\n');
        else process.stdout.write(line + '\n');
    } else {
        const metaStr = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
        const line = `${ts} [${label}] [${module}] ${msg}${metaStr}`;
        if (level >= LogLevel.ERROR) console.error(line);
        else if (level >= LogLevel.WARN) console.warn(line);
        else console.log(line);
    }
}

export interface Logger {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(module: string): Logger {
    return {
        debug: (msg, meta?) => emit(LogLevel.DEBUG, module, msg, meta),
        info: (msg, meta?) => emit(LogLevel.INFO, module, msg, meta),
        warn: (msg, meta?) => emit(LogLevel.WARN, module, msg, meta),
        error: (msg, meta?) => emit(LogLevel.ERROR, module, msg, meta),
    };
}
