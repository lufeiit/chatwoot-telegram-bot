import fs from 'fs';
import path from 'path';
import 'dotenv/config';

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

// ============ Log File Rotation ============

const LOG_DIR = process.env.LOG_DIR || './logs';
const MAX_LOG_SIZE_BYTES = parseInt(process.env.LOG_MAX_SIZE_MB || '10', 10) * 1024 * 1024; // default 10MB
const MAX_LOG_FILES = parseInt(process.env.LOG_MAX_FILES || '3', 10); // keep 3 rotated files
const LOG_TO_FILE = process.env.LOG_TO_FILE === 'true';

let logStream: fs.WriteStream | null = null;
let currentLogSize = 0;

function getLogFilePath(index?: number): string {
    const base = path.join(LOG_DIR, 'app.log');
    return index ? `${base}.${index}` : base;
}

function initLogFile(): void {
    if (!LOG_TO_FILE) return;

    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch { /* exists */ }

    const logPath = getLogFilePath();
    try {
        const stat = fs.statSync(logPath);
        currentLogSize = stat.size;
    } catch {
        currentLogSize = 0;
    }

    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', (err) => {
        console.error('Log file write error:', err.message);
        logStream = null;
    });
}

function rotateLogFile(): void {
    if (!logStream) return;

    logStream.end();
    logStream = null;

    // Rotate: app.log.3 → delete, app.log.2 → app.log.3, app.log.1 → app.log.2, app.log → app.log.1
    for (let i = MAX_LOG_FILES; i >= 1; i--) {
        const src = i === 1 ? getLogFilePath() : getLogFilePath(i - 1);
        const dst = getLogFilePath(i);
        try {
            if (i === MAX_LOG_FILES) {
                fs.unlinkSync(dst);
            }
        } catch { /* may not exist */ }
        try {
            fs.renameSync(src, dst);
        } catch { /* may not exist */ }
    }

    currentLogSize = 0;
    logStream = fs.createWriteStream(getLogFilePath(), { flags: 'a' });
    logStream.on('error', (err) => {
        console.error('Log file write error:', err.message);
        logStream = null;
    });
}

function writeToFile(line: string): void {
    if (!logStream) return;

    const bytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
    if (currentLogSize + bytes > MAX_LOG_SIZE_BYTES) {
        rotateLogFile();
    }

    logStream.write(line + '\n');
    currentLogSize += bytes;
}

// Initialize log file if enabled
initLogFile();

// ============ Axios Error Extraction ============

/**
 * Extract structured error information from Axios errors.
 * Captures HTTP status, response body, request URL, and method.
 */
export function extractAxiosError(error: unknown): Record<string, unknown> {
    const axErr = error as {
        response?: { status?: number; data?: unknown; statusText?: string };
        config?: { url?: string; method?: string; baseURL?: string };
        message?: string;
        code?: string;
    };

    const result: Record<string, unknown> = {};

    if (axErr?.response) {
        result.httpStatus = axErr.response.status;
        result.statusText = axErr.response.statusText;
        // Truncate response data to avoid massive log entries
        const data = axErr.response.data;
        if (typeof data === 'string') {
            result.responseBody = data.length > 500 ? data.substring(0, 500) + '...' : data;
        } else if (data != null) {
            const json = JSON.stringify(data);
            result.responseBody = json.length > 500 ? json.substring(0, 500) + '...' : json;
        }
    }
    if (axErr?.config) {
        result.requestUrl = axErr.config.url;
        result.requestMethod = axErr.config.method?.toUpperCase();
        if (axErr.config.baseURL) result.baseURL = axErr.config.baseURL;
    }
    if (axErr?.code) result.errorCode = axErr.code;
    if (axErr?.message) result.message = axErr.message;

    return Object.keys(result).length > 0 ? result : { raw: String(error) };
}

// ============ Core Emit ============

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
        writeToFile(line);
    } else {
        const metaStr = meta && Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
        const line = `${ts} [${label}] [${module}] ${msg}${metaStr}`;
        if (level >= LogLevel.ERROR) console.error(line);
        else if (level >= LogLevel.WARN) console.warn(line);
        else console.log(line);
        writeToFile(line);
    }
}

// ============ Logger Interface ============

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

// ============ Shutdown ============

/** 关闭日志文件流，确保最后几条 buffer 落盘。 */
export function closeLogger(): Promise<void> {
    return new Promise((resolve) => {
        if (!logStream) {
            resolve();
            return;
        }
        const stream = logStream;
        logStream = null;
        stream.end(() => resolve());
    });
}
