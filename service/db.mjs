// SQLite 建库/迁移/查询辅助。
// 只用 node:sqlite（Node 24 内置，无原生编译）。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DB_FILENAME = 'secretary.db';

/** docs/API.md §5 的默认设置，一字不差 */
export const DEFAULT_PREFS = Object.freeze({
  petHeight: 180,
  petScale: 1.0,
  topmost: true,
  alwaysOnTop: true,
  autoStart: false,
  bootGreeting: true,
  bootSnoozeMin: 30,
  fineWindowDays: 5,
  slotMinutes: 30,
  timeFormat: '24h',
  timezone: 'system',
  language: 'zh-CN',
  theme: 'system',
  taskReminder: true,
  aiSuggestions: true,
  aiAutoApply: false,
  waterEveryMin: 120,
  restEveryMin: 50,
  restLengthMin: 10,
  meals: ['11:00', '18:00'],
  dnd: { active: false, from: '23:00', to: '07:00' },
  notify: { system: true, pet: true, sound: false },
});

/** 需要做类型校验的设置项（PATCH /settings 用） */
export const PREF_SCHEMA = Object.freeze({
  petHeight: 'int',
  petScale: 'number',
  topmost: 'bool',
  alwaysOnTop: 'bool',
  autoStart: 'bool',
  bootGreeting: 'bool',
  bootSnoozeMin: 'int',
  fineWindowDays: 'int',
  slotMinutes: 'int',
  timeFormat: 'string',
  timezone: 'string',
  language: 'string',
  theme: 'string',
  taskReminder: 'bool',
  aiSuggestions: 'bool',
  aiAutoApply: 'bool',
  waterEveryMin: 'int',
  restEveryMin: 'int',
  restLengthMin: 'int',
  meals: 'times',
  dnd: 'dnd',
  notify: 'notify',
});

// ---------------------------------------------------------------------------
// 查询辅助：语句缓存 + 参数归一化（node:sqlite 不接受 boolean/undefined）
// ---------------------------------------------------------------------------

const stmtCache = new WeakMap();
const txDepth = new WeakMap();

function normalizeParam(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function normalizeParams(params) {
  if (params.length === 0) return params;
  return params.map(normalizeParam);
}

function prepare(db, sql) {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

export function get(db, sql, ...params) {
  return prepare(db, sql).get(...normalizeParams(params));
}

export function all(db, sql, ...params) {
  return prepare(db, sql).all(...normalizeParams(params));
}

export function run(db, sql, ...params) {
  return prepare(db, sql).run(...normalizeParams(params));
}

/** 同步事务；嵌套调用只执行最外层 BEGIN/COMMIT */
export function tx(db, fn) {
  const depth = txDepth.get(db) || 0;
  if (depth > 0) {
    txDepth.set(db, depth + 1);
    try {
      return fn();
    } finally {
      txDepth.set(db, depth);
    }
  }
  txDepth.set(db, 1);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* rollback 失败不再掩盖原始错误 */
    }
    throw err;
  } finally {
    txDepth.set(db, 0);
  }
}

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

const MIGRATIONS = [
  // v1：初始 schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        title       TEXT NOT NULL,
        notes       TEXT NOT NULL DEFAULT '',
        parentId    TEXT REFERENCES items(id) ON DELETE SET NULL,
        status      TEXT NOT NULL DEFAULT 'planned',
        progress    INTEGER NOT NULL DEFAULT 0,
        precision   TEXT NOT NULL DEFAULT 'unscheduled',
        startDate   TEXT,
        endDate     TEXT,
        startTime   TEXT,
        endTime     TEXT,
        dueDate     TEXT,
        fuzzyLabel  TEXT,
        locked      INTEGER NOT NULL DEFAULT 0,
        priority    INTEGER NOT NULL DEFAULT 2,
        color       TEXT,
        tags        TEXT NOT NULL DEFAULT '[]',
        source      TEXT NOT NULL DEFAULT 'user',
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL,
        completedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_items_kind      ON items(kind);
      CREATE INDEX IF NOT EXISTS idx_items_status    ON items(status);
      CREATE INDEX IF NOT EXISTS idx_items_parent    ON items(parentId);
      CREATE INDEX IF NOT EXISTS idx_items_precision ON items(precision);
      CREATE INDEX IF NOT EXISTS idx_items_start     ON items(startDate);
      CREATE INDEX IF NOT EXISTS idx_items_due       ON items(dueDate);

      CREATE TABLE IF NOT EXISTS dependencies (
        id     TEXT PRIMARY KEY,
        fromId TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        toId   TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        type   TEXT NOT NULL DEFAULT 'finish-to-start',
        UNIQUE (fromId, toId)
      );
      CREATE INDEX IF NOT EXISTS idx_deps_from ON dependencies(fromId);
      CREATE INDEX IF NOT EXISTS idx_deps_to   ON dependencies(toId);

      -- 注意：reminders.itemId 故意不加外键。删除 item 时提醒会被 cancelled 保留下来，
      -- 保留 itemId 便于追溯；加了 ON DELETE SET NULL 会丢失这条审计线索。
      CREATE TABLE IF NOT EXISTS reminders (
        id          TEXT PRIMARY KEY,
        itemId      TEXT,
        kind        TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        fireAt      TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        firedAt     TEXT,
        snoozedTo   TEXT,
        repeatOf    TEXT,
        dedupeKey   TEXT NOT NULL,
        catchup     INTEGER NOT NULL DEFAULT 0,
        createdAt   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_reminders_dedupe ON reminders(dedupeKey);
      CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
      CREATE INDEX IF NOT EXISTS idx_reminders_fire   ON reminders(fireAt);
      CREATE INDEX IF NOT EXISTS idx_reminders_item   ON reminders(itemId);

      CREATE TABLE IF NOT EXISTS proposals (
        id        TEXT PRIMARY KEY,
        kind      TEXT NOT NULL DEFAULT 'plan',
        title     TEXT NOT NULL,
        summary   TEXT NOT NULL DEFAULT '',
        ops       TEXT NOT NULL DEFAULT '[]',
        payload   TEXT NOT NULL DEFAULT '{}',
        status    TEXT NOT NULL DEFAULT 'draft',
        createdAt TEXT NOT NULL,
        expiresAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

      CREATE TABLE IF NOT EXISTS history (
        id     TEXT PRIMARY KEY,
        itemId TEXT,
        at     TEXT NOT NULL,
        action TEXT NOT NULL,
        before TEXT,
        after  TEXT,
        source TEXT NOT NULL DEFAULT 'user'
      );
      CREATE INDEX IF NOT EXISTS idx_history_item ON history(itemId);
      CREATE INDEX IF NOT EXISTS idx_history_at   ON history(at);

      CREATE TABLE IF NOT EXISTS prefs (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        text       TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        source     TEXT NOT NULL DEFAULT 'user',
        createdAt  TEXT NOT NULL,
        expiresAt  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory(kind);

      -- bootEvents：契约 §1.5 列了 id/kind/at/greeted/snoozeUntil/action，
      -- 但 §2.7 要求"同一 sessionId 只 shouldGreet 一次"，因此补充 sessionId 列
      -- 与唯一索引。这是实现必要字段，已在 docs/API.md 追加实现备注。
      CREATE TABLE IF NOT EXISTS bootEvents (
        id          TEXT PRIMARY KEY,
        sessionId   TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'login',
        at          TEXT NOT NULL,
        greeted     INTEGER NOT NULL DEFAULT 0,
        snoozeUntil TEXT,
        action      TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_boot_session ON bootEvents(sessionId);
    `);
  },
];

export function migrate(db) {
  const row = get(db, 'PRAGMA user_version');
  const current = row ? Number(row.user_version) : 0;
  for (let i = current; i < MIGRATIONS.length; i += 1) {
    tx(db, () => {
      MIGRATIONS[i](db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return MIGRATIONS.length;
}

/**
 * 打开/创建数据库。
 * @returns {{ db: import('node:sqlite').DatabaseSync, dbPath: string }}
 */
export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, DB_FILENAME);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate(db);
  return { db, dbPath };
}

// ---------------------------------------------------------------------------
// prefs 读写
// ---------------------------------------------------------------------------

export function readPrefs(db) {
  const out = JSON.parse(JSON.stringify(DEFAULT_PREFS));
  const rows = all(db, 'SELECT key, value FROM prefs');
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

export function writePref(db, key, value) {
  run(
    db,
    `INSERT INTO prefs(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    JSON.stringify(value),
  );
}

export function getPref(db, key) {
  const row = get(db, 'SELECT value FROM prefs WHERE key = ?', key);
  if (!row) return DEFAULT_PREFS[key];
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function dbFileSize(dbPath) {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += fs.statSync(dbPath + suffix).size;
    } catch {
      /* 文件可能不存在 */
    }
  }
  return total;
}
