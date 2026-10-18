import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

let dbInstance = null;
let inMemoryRows = [];
const require = createRequire(import.meta.url);

function getDbPath() {
    const dataDir = path.join(process.cwd(), '.rex-data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    return path.join(dataDir, 'intent-index.db');
}

function getDb() {
    if (dbInstance) return dbInstance;

    try {
        // eslint-disable-next-line global-require
        const BetterSqlite3 = require('better-sqlite3');
        const db = new BetterSqlite3(getDbPath());
        db.exec(`
            CREATE TABLE IF NOT EXISTS file_index (
                path TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                modified_ms INTEGER NOT NULL,
                extracted_text TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_file_name ON file_index(name);
            CREATE INDEX IF NOT EXISTS idx_file_mtime ON file_index(modified_ms);
            CREATE TABLE IF NOT EXISTS memory_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                payload TEXT,
                created_at TEXT NOT NULL
            );
        `);
        dbInstance = db;
        return dbInstance;
    } catch {
        return null;
    }
}

export function upsertIndexRow(row = {}) {
    const record = {
        path: String(row.path || ''),
        name: String(row.name || ''),
        modifiedMs: Number(row.modifiedMs || 0),
        extractedText: row.extractedText == null ? null : String(row.extractedText)
    };

    const db = getDb();
    if (!db) {
        const idx = inMemoryRows.findIndex((r) => r.path === record.path);
        if (idx >= 0) inMemoryRows[idx] = record;
        else inMemoryRows.push(record);
        return;
    }

    const stmt = db.prepare(`
        INSERT INTO file_index(path, name, modified_ms, extracted_text)
        VALUES(@path, @name, @modifiedMs, @extractedText)
        ON CONFLICT(path) DO UPDATE SET
            name = excluded.name,
            modified_ms = excluded.modified_ms,
            extracted_text = excluded.extracted_text
    `);
    stmt.run(record);
}

export function searchIndex(query = '', limit = 20) {
    const q = `%${String(query || '').toLowerCase()}%`;
    const db = getDb();
    if (!db) {
        return inMemoryRows
            .filter((r) => r.name.toLowerCase().includes(String(query).toLowerCase()) || String(r.path).toLowerCase().includes(String(query).toLowerCase()))
            .slice(0, limit);
    }

    const stmt = db.prepare(`
        SELECT path, name, modified_ms as modifiedMs, extracted_text as extractedText
        FROM file_index
        WHERE lower(name) LIKE ? OR lower(path) LIKE ? OR lower(coalesce(extracted_text, '')) LIKE ?
        ORDER BY modified_ms DESC
        LIMIT ?
    `);

    return stmt.all(q, q, q, Number(limit || 20));
}

export function rememberEvent(eventType = '', payload = {}) {
    const db = getDb();
    if (!db) return;

    const stmt = db.prepare('INSERT INTO memory_events(event_type, payload, created_at) VALUES(?, ?, ?)');
    stmt.run(String(eventType), JSON.stringify(payload || {}), new Date().toISOString());
}

export function getRecentEvents(limit = 15) {
    const db = getDb();
    if (!db) return [];

    const stmt = db.prepare('SELECT event_type as eventType, payload, created_at as createdAt FROM memory_events ORDER BY id DESC LIMIT ?');
    const rows = stmt.all(Number(limit || 15));
    return rows.map((r) => {
        let payload = {};
        try { payload = JSON.parse(r.payload || '{}'); } catch {}
        return { eventType: r.eventType, payload, createdAt: r.createdAt };
    });
}
