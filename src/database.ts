import Database from 'better-sqlite3';
import { config } from './config';
import { createLogger } from './logger';

const log = createLogger('database');
const db = new Database(config.dbPath);

const CURRENT_DB_VERSION = 2;

let insertMappingStmt: Database.Statement;
let selectMappingStmt: Database.Statement;
let insertTopicStmt: Database.Statement;
let selectTopicStmt: Database.Statement;
let deleteTopicStmt: Database.Statement;
let selectTopicByTopicIdStmt: Database.Statement;

function getDatabaseVersion(): number {
    try {
        const result = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
        return result?.version || 0;
    } catch {
        return 0;
    }
}

function setDatabaseVersion(version: number): void {
    db.prepare('INSERT OR REPLACE INTO schema_version (id, version, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP)').run(version);
}

function createSchemaVersionTable(): void {
    db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function migrateToVersion1(): void {
    log.info('Migrating to v1: creating messages table');
    db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      telegram_message_id INTEGER PRIMARY KEY,
      chatwoot_conversation_id INTEGER NOT NULL,
      chatwoot_account_id INTEGER,
      chatwoot_message_id INTEGER
    )
  `);
}

function migrateToVersion2(): void {
    log.info('Migrating to v2: creating topics table');
    db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      chatwoot_conversation_id INTEGER PRIMARY KEY,
      chatwoot_account_id INTEGER,
      telegram_topic_id INTEGER NOT NULL,
      topic_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function runMigrations(currentVersion: number): void {
    log.info(`Database version: ${currentVersion}, target: ${CURRENT_DB_VERSION}`);

    if (currentVersion === CURRENT_DB_VERSION) {
        log.info('Database is up to date');
        return;
    }

    const migrate = db.transaction(() => {
        if (currentVersion < 1) {
            migrateToVersion1();
            setDatabaseVersion(1);
        }
        if (currentVersion < 2) {
            migrateToVersion2();
            setDatabaseVersion(2);
        }
    });

    try {
        migrate();
        log.info(`Database migration complete, now at v${CURRENT_DB_VERSION}`);
    } catch (error) {
        log.error('Database migration failed', { error: String(error) });
        throw error;
    }
}

function initPreparedStatements(): void {
    insertMappingStmt = db.prepare(
        'INSERT OR REPLACE INTO messages (telegram_message_id, chatwoot_conversation_id, chatwoot_account_id, chatwoot_message_id) VALUES (?, ?, ?, ?)'
    );
    selectMappingStmt = db.prepare('SELECT * FROM messages WHERE telegram_message_id = ?');

    insertTopicStmt = db.prepare(
        'INSERT OR REPLACE INTO topics (chatwoot_conversation_id, chatwoot_account_id, telegram_topic_id, topic_name) VALUES (?, ?, ?, ?)'
    );
    selectTopicStmt = db.prepare('SELECT telegram_topic_id, topic_name, chatwoot_account_id FROM topics WHERE chatwoot_conversation_id = ?');
    deleteTopicStmt = db.prepare('DELETE FROM topics WHERE chatwoot_conversation_id = ?');
    selectTopicByTopicIdStmt = db.prepare('SELECT chatwoot_conversation_id, chatwoot_account_id, topic_name FROM topics WHERE telegram_topic_id = ?');
}

export function initDb() {
    log.info('Initializing database...');

    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    db.pragma('busy_timeout = 5000');
    db.pragma('cache_size = -64000');

    createSchemaVersionTable();
    const currentVersion = getDatabaseVersion();
    runMigrations(currentVersion);
    initPreparedStatements();

    log.info('Database initialization complete');
}

// ============ Messages ============

export function saveMapping(telegramMessageId: number, conversationId: number, accountId?: number, chatwootMessageId?: number) {
    insertMappingStmt.run(telegramMessageId, conversationId, accountId, chatwootMessageId);
}

export function getMapping(telegramMessageId: number) {
    return selectMappingStmt.get(telegramMessageId) as { chatwoot_conversation_id: number; chatwoot_account_id?: number; chatwoot_message_id?: number } | undefined;
}

// ============ Topics ============

export function saveTopic(conversationId: number, accountId: number | undefined, topicId: number, topicName: string) {
    insertTopicStmt.run(conversationId, accountId, topicId, topicName);
}

export function getTopic(conversationId: number) {
    return selectTopicStmt.get(conversationId) as { telegram_topic_id: number; topic_name: string; chatwoot_account_id?: number } | undefined;
}

export function deleteTopic(conversationId: number) {
    deleteTopicStmt.run(conversationId);
}

export function getTopicByTopicId(telegramTopicId: number) {
    return selectTopicByTopicIdStmt.get(telegramTopicId) as { chatwoot_conversation_id: number; chatwoot_account_id?: number; topic_name: string } | undefined;
}

// ============ Shutdown ============

/** 优雅关闭 SQLite 连接（flush WAL，避免日志写半截）。 */
export function closeDb() {
    try {
        db.close();
        log.info('Database closed');
    } catch (err) {
        log.warn('Failed to close database', { error: String(err) });
    }
}
