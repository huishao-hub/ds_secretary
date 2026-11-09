// items / dependencies / proposals / history / prefs 的数据模型层。
// 所有写入都过这里：校验 -> 精度实体化 -> 事务 -> history。
import crypto from 'node:crypto';
import { all, get, run, tx, readPrefs, writePref, DEFAULT_PREFS, PREF_SCHEMA } from './db.mjs';
import { badRequest, notFound, lockedError } from './errors.mjs';
import {
  addDays,
  diffDays,
  expandPrecision,
  isValidDate,
  isValidTime,
  isValidStamp,
  nowStamp,
  pad2,
  parseDate,
  parseTime,
  quarterLabel,
  today,
} from './time.mjs';

export const KINDS = ['goal', 'project', 'phase', 'milestone', 'task'];
export const STATUSES = ['idea', 'planned', 'active', 'done', 'cancelled', 'paused'];
export const PRECISIONS = ['year', 'quarter', 'month', 'week', 'day', 'slot', 'unscheduled'];
export const SOURCES = ['user', 'ai', 'import'];
export const DEP_TYPES = ['finish-to-start'];

const KIND_PREFIX = { goal: 'g', project: 'p', phase: 'p', milestone: 'm', task: 't' };
const ITEM_FIELDS = [
  'kind', 'title', 'notes', 'parentId', 'status', 'progress', 'precision',
  'startDate', 'endDate', 'startTime', 'endTime', 'dueDate', 'fuzzyLabel',
  'locked', 'priority', 'color', 'tags', 'source', 'completedAt',
];

export function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function rowToItem(row) {
  if (!row) return null;
  let tags = [];
  try {
    const parsed = JSON.parse(row.tags || '[]');
    tags = Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    notes: row.notes || '',
    parentId: row.parentId ?? null,
    status: row.status,
    progress: Number(row.progress) || 0,
    precision: row.precision,
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
    startTime: row.startTime ?? null,
    endTime: row.endTime ?? null,
    dueDate: row.dueDate ?? null,
    fuzzyLabel: row.fuzzyLabel ?? null,
    locked: Number(row.locked) ? 1 : 0,
    priority: Number(row.priority) ?? 2,
    color: row.color ?? null,
    tags,
    source: row.source || 'user',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function needString(v, name, max, { required = false, allowEmpty = true } = {}) {
  if (v === undefined || v === null) {
    if (required) throw badRequest(`${name} is required`);
    return '';
  }
  if (typeof v !== 'string') throw badRequest(`${name} must be a string`);
  const s = v.trim();
  if (required && !s) throw badRequest(`${name} is required`);
  if (!allowEmpty && !s) throw badRequest(`${name} must not be empty`);
  if (s.length > max) throw badRequest(`${name} must be <= ${max} chars`);
  return s;
}

function needEnum(v, name, allowed, fallback) {
  if (v === undefined || v === null) return fallback;
  if (!allowed.includes(v)) {
    throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return v;
}

function needInt(v, name, min, max, fallback) {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw badRequest(`${name} must be an integer`);
  }
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

function needLocked(v) {
  if (v === undefined || v === null) return 0;
  if (v === true) return 1;
  if (v === false) return 0;
  if (v === 1 || v === 0) return v;
  throw badRequest('locked must be 0/1 or boolean');
}

function needDate(v, name) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !isValidDate(v)) {
    throw badRequest(`${name} must be YYYY-MM-DD`);
  }
  return v;
}

function needTime(v, name) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !isValidTime(v)) throw badRequest(`${name} must be HH:mm`);
  return v;
}

function needTags(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw badRequest('tags must be an array');
  if (v.length > 50) throw badRequest('tags must have <= 50 entries');
  const out = [];
  for (const t of v) {
    if (typeof t !== 'string') throw badRequest('tags must be strings');
    const s = t.trim();
    if (!s) continue;
    if (s.length > 40) throw badRequest('each tag must be <= 40 chars');
    out.push(s);
  }
  return [...new Set(out)];
}

/**
 * 落库前的最终形状：校验 + 精度实体化。
 * 关键：year/quarter/month/week 的 endDate 一律由服务端根据 startDate 重算，
 * unscheduled 一律清空所有时间字段（绝不推断日期）。
 */
export function normalizeItem(full, { db, selfId = null } = {}) {
  const kind = needEnum(full.kind, 'kind', KINDS, 'task');
  const title = needString(full.title, 'title', 120, { required: true, allowEmpty: false });
  const notes = needString(full.notes, 'notes', 2000);
  const status = needEnum(full.status, 'status', STATUSES, 'planned');
  const precision = needEnum(full.precision, 'precision', PRECISIONS, 'unscheduled');
  const progress = needInt(full.progress, 'progress', 0, 100, 0);
  const priority = needInt(full.priority, 'priority', 0, 4, 2);
  const locked = needLocked(full.locked);
  const source = needEnum(full.source, 'source', SOURCES, 'user');
  const startRaw = needDate(full.startDate, 'startDate');
  const endRaw = needDate(full.endDate, 'endDate');
  const dueDate = needDate(full.dueDate, 'dueDate');
  const startTimeRaw = needTime(full.startTime, 'startTime');
  const endTimeRaw = needTime(full.endTime, 'endTime');
  let color = full.color ?? null;
  if (color !== null) {
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      throw badRequest('color must be #RRGGBB');
    }
    color = color.toUpperCase();
  }
  const tags = needTags(full.tags);
  let fuzzyLabel = full.fuzzyLabel ?? null;
  if (fuzzyLabel !== null) {
    if (typeof fuzzyLabel !== 'string') throw badRequest('fuzzyLabel must be a string');
    fuzzyLabel = fuzzyLabel.trim().slice(0, 120) || null;
  }

  let startDate = startRaw;
  let startTime = null;
  let endTime = null;

  if (precision === 'unscheduled') {
    // 契约：unscheduled 没有时间，禁止推断成任何日期。输入里带了也清掉。
    startDate = null;
  } else if (precision === 'slot') {
    if (!startDate) throw badRequest('slot precision requires startDate');
    if (!startTimeRaw || !endTimeRaw) {
      throw badRequest('slot precision requires startTime and endTime');
    }
    const s = parseTime(startTimeRaw);
    const e = parseTime(endTimeRaw);
    if (e.h * 60 + e.m <= s.h * 60 + s.m) {
      throw badRequest('slot endTime must be later than startTime');
    }
    // 统一补零成 HH:mm，避免 "9:05" 这种不符合契约格式的值落库
    startTime = `${pad2(s.h)}:${pad2(s.m)}`;
    endTime = `${pad2(e.h)}:${pad2(e.m)}`;
  } else {
    // year / quarter / month / week / day 没有时刻
    if (!startDate) throw badRequest(`${precision} precision requires startDate`);
    startTime = null;
    endTime = null;
  }

  const interval = expandPrecision(precision, startDate, {
    startTime,
    endTime,
    endDate: endRaw,
  });
  if (precision !== 'unscheduled' && !interval.startDate) {
    throw badRequest(`cannot materialize ${precision} interval from startDate`);
  }

  // quarter 的 fuzzyLabel 记录季度号（服务端由 startDate 反推）
  if (precision === 'quarter' && !fuzzyLabel) {
    fuzzyLabel = quarterLabel(interval.startDate);
  }
  if (precision === 'year' && !fuzzyLabel) {
    fuzzyLabel = `${parseDate(interval.startDate).y} 年`;
  }

  // 父节点校验：必须存在、不能是 task、不能成环
  let parentId = full.parentId ?? null;
  if (parentId === '') parentId = null;
  if (parentId !== null) {
    if (typeof parentId !== 'string') throw badRequest('parentId must be a string or null');
    if (selfId && parentId === selfId) throw badRequest('parentId must not reference itself');
    if (db) {
      const parent = get(db, 'SELECT id, kind FROM items WHERE id = ?', parentId);
      if (!parent) throw badRequest(`parent ${parentId} not found`, 'PARENT_NOT_FOUND');
      if (parent.kind === 'task') throw badRequest('parent must not be a task', 'PARENT_IS_TASK');
      if (selfId) {
        // 沿父链向上走，若回到自己则成环
        let cursor = parentId;
        const seen = new Set([selfId]);
        while (cursor) {
          if (seen.has(cursor)) throw badRequest('parent chain cycle', 'PARENT_CYCLE');
          seen.add(cursor);
          const row = get(db, 'SELECT parentId FROM items WHERE id = ?', cursor);
          cursor = row ? row.parentId : null;
        }
      }
    }
  }

  const completedAt =
    status === 'done' ? full.completedAt && isValidStamp(full.completedAt) ? full.completedAt : nowStamp() : null;

  return {
    kind,
    title,
    notes,
    parentId,
    status,
    progress: status === 'done' ? 100 : progress,
    precision,
    startDate: interval.startDate,
    endDate: interval.endDate,
    startTime: interval.startTime,
    endTime: interval.endTime,
    dueDate,
    fuzzyLabel,
    locked,
    priority,
    color,
    tags,
    source,
    completedAt,
  };
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

export function writeHistory(db, { itemId = null, action, before = null, after = null, source = 'user' }) {
  const row = {
    id: makeId('h'),
    itemId,
    at: nowStamp(),
    action,
    before: before == null ? null : JSON.stringify(before),
    after: after == null ? null : JSON.stringify(after),
    source,
  };
  run(
    db,
    `INSERT INTO history(id, itemId, at, action, before, after, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.itemId,
    row.at,
    row.action,
    row.before,
    row.after,
    row.source,
  );
  return row;
}

// ---------------------------------------------------------------------------
// items CRUD
// ---------------------------------------------------------------------------

export function getItemRow(db, id) {
  return get(db, 'SELECT * FROM items WHERE id = ?', id);
}

export function getItem(db, id) {
  return rowToItem(getItemRow(db, id));
}

export function requireItem(db, id) {
  const item = getItem(db, id);
  if (!item) throw notFound(`item ${id} not found`, 'ITEM_NOT_FOUND');
  return item;
}

export function createItem(db, input, { source = null, actorSource = null } = {}) {
  if (!input || typeof input !== 'object') throw badRequest('item body must be an object');
  const effectiveSource = source || input.source || 'user';
  const now = nowStamp();
  const normalized = normalizeItem(
    {
      ...input,
      source: effectiveSource,
      completedAt: input.completedAt,
    },
    { db },
  );
  const id = input.id && typeof input.id === 'string' ? input.id : makeId(KIND_PREFIX[normalized.kind] || 't');
  if (get(db, 'SELECT 1 AS x FROM items WHERE id = ?', id)) {
    throw badRequest(`item ${id} already exists`, 'ITEM_EXISTS');
  }
  return tx(db, () => {
    run(
      db,
      `INSERT INTO items(
        id, kind, title, notes, parentId, status, progress, precision,
        startDate, endDate, startTime, endTime, dueDate, fuzzyLabel,
        locked, priority, color, tags, source, createdAt, updatedAt, completedAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      normalized.kind,
      normalized.title,
      normalized.notes,
      normalized.parentId,
      normalized.status,
      normalized.progress,
      normalized.precision,
      normalized.startDate,
      normalized.endDate,
      normalized.startTime,
      normalized.endTime,
      normalized.dueDate,
      normalized.fuzzyLabel,
      normalized.locked,
      normalized.priority,
      normalized.color,
      JSON.stringify(normalized.tags),
      normalized.source,
      now,
      now,
      normalized.completedAt,
    );
    const item = getItem(db, id);
    writeHistory(db, {
      itemId: id,
      action: 'create',
      after: item,
      source: actorSource || effectiveSource,
    });
    return item;
  });
}

/**
 * 局部更新。
 * 契约 §2.2：locked=1 的 item 被 AI 来源修改时 409；source:'user' 允许。
 */
export function updateItem(db, id, patch, { source = 'user', actorSource = null, bypassLocked = false } = {}) {
  if (!patch || typeof patch !== 'object') throw badRequest('patch body must be an object');
  const existing = requireItem(db, id);
  if (existing.locked && source !== 'user' && !bypassLocked) {
    throw lockedError();
  }
  const merged = { ...existing };
  for (const key of ITEM_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) merged[key] = patch[key];
  }
  merged.source = existing.source;
  const normalized = normalizeItem(merged, { db, selfId: id });

  return tx(db, () => {
    run(
      db,
      `UPDATE items SET
        kind=?, title=?, notes=?, parentId=?, status=?, progress=?, precision=?,
        startDate=?, endDate=?, startTime=?, endTime=?, dueDate=?, fuzzyLabel=?,
        locked=?, priority=?, color=?, tags=?, source=?, updatedAt=?, completedAt=?
       WHERE id=?`,
      normalized.kind,
      normalized.title,
      normalized.notes,
      normalized.parentId,
      normalized.status,
      normalized.progress,
      normalized.precision,
      normalized.startDate,
      normalized.endDate,
      normalized.startTime,
      normalized.endTime,
      normalized.dueDate,
      normalized.fuzzyLabel,
      normalized.locked,
      normalized.priority,
      normalized.color,
      JSON.stringify(normalized.tags),
      normalized.source,
      nowStamp(),
      normalized.completedAt,
      id,
    );
    const after = getItem(db, id);
    writeHistory(db, {
      itemId: id,
      action: 'update',
      before: existing,
      after,
      source: actorSource || source,
    });
    return after;
  });
}

export function deleteItem(db, id, { source = 'user' } = {}) {
  const existing = requireItem(db, id);
  return tx(db, () => {
    run(
      db,
      `UPDATE reminders SET status='cancelled'
       WHERE itemId = ? AND status IN ('pending','fired')`,
      id,
    );
    run(db, 'UPDATE items SET parentId = NULL WHERE parentId = ?', id);
    run(db, 'DELETE FROM dependencies WHERE fromId = ? OR toId = ?', id, id);
    run(db, 'DELETE FROM items WHERE id = ?', id);
    writeHistory(db, { itemId: id, action: 'delete', before: existing, after: null, source });
    return { deleted: true, id, childrenDetached: true };
  });
}

export function setProgress(db, id, { progress, status } = {}, { source = 'user' } = {}) {
  const existing = requireItem(db, id);
  if (existing.locked && source !== 'user') throw lockedError();
  let nextProgress = existing.progress;
  let nextStatus = existing.status;
  if (progress !== undefined && progress !== null) {
    nextProgress = needInt(progress, 'progress', 0, 100, existing.progress);
  }
  if (status !== undefined && status !== null) {
    nextStatus = needEnum(status, 'status', STATUSES, existing.status);
  }
  if (nextStatus === 'done') nextProgress = 100;
  return updateItem(db, id, { progress: nextProgress, status: nextStatus }, { source });
}

export function setLock(db, id, locked) {
  const existing = requireItem(db, id);
  const value = needLocked(locked);
  return updateItem(db, id, { locked: value }, { source: 'user' }).locked === value
    ? getItem(db, id)
    : existing;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function listItems(db, query = {}) {
  const where = [];
  const params = [];
  const { kind, status, q, from, to, parentId, locked, unscheduled, limit, offset } = query;

  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  if (status) {
    const list = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    where.push(`status IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (q) {
    where.push('(instr(lower(title), lower(?)) > 0 OR instr(lower(notes), lower(?)) > 0)');
    params.push(q, q);
  }
  if (from) {
    if (!isValidDate(from)) throw badRequest('from must be YYYY-MM-DD');
    where.push('((startDate IS NOT NULL AND endDate IS NOT NULL AND startDate <= ? AND endDate >= ?) OR dueDate >= ?)');
    params.push(from, from, from);
  }
  if (to) {
    if (!isValidDate(to)) throw badRequest('to must be YYYY-MM-DD');
    where.push('((startDate IS NOT NULL AND startDate <= ?) OR dueDate <= ?)');
    params.push(to, to);
  }
  if (parentId !== undefined) {
    if (parentId === 'null' || parentId === null) where.push('parentId IS NULL');
    else {
      where.push('parentId = ?');
      params.push(parentId);
    }
  }
  if (locked !== undefined) {
    where.push('locked = ?');
    params.push(locked === '1' || locked === 1 || locked === 'true' ? 1 : 0);
  }
  if (unscheduled === '1' || unscheduled === 1 || unscheduled === 'true') {
    where.push("precision = 'unscheduled'");
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const off = Math.max(Number(offset) || 0, 0);

  const rows = all(
    db,
    `SELECT * FROM items ${whereSql}
     ORDER BY CASE WHEN startDate IS NULL THEN 1 ELSE 0 END, startDate ASC,
              priority DESC, createdAt ASC
     LIMIT ? OFFSET ?`,
    ...params,
    lim,
    off,
  );
  const totalRow = get(db, `SELECT COUNT(*) AS c FROM items ${whereSql}`, ...params);
  return { items: rows.map(rowToItem), total: totalRow ? Number(totalRow.c) : 0 };
}

export function getItemDetail(db, id) {
  const item = requireItem(db, id);
  const children = all(db, 'SELECT * FROM items WHERE parentId = ? ORDER BY startDate IS NULL, startDate, createdAt', id).map(rowToItem);
  const deps = all(db, 'SELECT * FROM dependencies WHERE fromId = ? OR toId = ?', id, id).map(rowToDep);
  const reminders = all(
    db,
    `SELECT * FROM reminders WHERE itemId = ? ORDER BY fireAt DESC LIMIT 50`,
    id,
  ).map(rowToReminder);
  return { ...item, children, deps, reminders };
}

export function getTree(db) {
  const rows = all(
    db,
    `SELECT * FROM items ORDER BY CASE WHEN startDate IS NULL THEN 1 ELSE 0 END, startDate ASC,
            priority DESC, createdAt ASC`,
  ).map(rowToItem);
  const map = new Map();
  for (const item of rows) map.set(item.id, { item, children: [] });
  const roots = [];
  for (const node of map.values()) {
    const parent = node.item.parentId ? map.get(node.item.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return { nodes: roots };
}

export function countItems(db) {
  const row = get(db, 'SELECT COUNT(*) AS c FROM items');
  return row ? Number(row.c) : 0;
}

// ---------------------------------------------------------------------------
// dependencies
// ---------------------------------------------------------------------------

export function rowToDep(row) {
  return { id: row.id, fromId: row.fromId, toId: row.toId, type: row.type };
}

export function listDependencies(db, { itemId } = {}) {
  const rows = itemId
    ? all(db, 'SELECT * FROM dependencies WHERE fromId = ? OR toId = ?', itemId, itemId)
    : all(db, 'SELECT * FROM dependencies');
  return rows.map(rowToDep);
}

function hasPath(db, startId, targetId) {
  // 沿 fromId -> toId 方向走；用于判断新增 from->to 是否成环
  const stack = [startId];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === targetId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const edges = all(db, 'SELECT toId FROM dependencies WHERE fromId = ?', cur);
    for (const e of edges) stack.push(e.toId);
  }
  return false;
}

export function addDependency(db, input = {}) {
  const fromId = input.fromId;
  const toId = input.toId;
  const type = input.type || 'finish-to-start';
  if (!fromId || !toId) throw badRequest('fromId and toId are required');
  if (fromId === toId) throw badRequest('dependency must not be a self-loop', 'DEP_SELF_LOOP');
  if (!DEP_TYPES.includes(type)) throw badRequest(`type must be one of: ${DEP_TYPES.join(', ')}`);
  requireItem(db, fromId);
  requireItem(db, toId);
  if (hasPath(db, toId, fromId)) {
    throw badRequest('dependency would create a cycle', 'DEP_CYCLE');
  }
  const existing = get(
    db,
    'SELECT * FROM dependencies WHERE fromId = ? AND toId = ?',
    fromId,
    toId,
  );
  if (existing) return rowToDep(existing);
  const id = input.id || makeId('d');
  run(
    db,
    'INSERT INTO dependencies(id, fromId, toId, type) VALUES (?, ?, ?, ?)',
    id,
    fromId,
    toId,
    type,
  );
  writeHistory(db, {
    itemId: toId,
    action: 'dependency-add',
    after: { fromId, toId, type },
    source: input.source || 'user',
  });
  return rowToDep(get(db, 'SELECT * FROM dependencies WHERE id = ?', id));
}

export function deleteDependency(db, id) {
  const row = get(db, 'SELECT * FROM dependencies WHERE id = ?', id);
  if (!row) throw notFound(`dependency ${id} not found`, 'DEP_NOT_FOUND');
  run(db, 'DELETE FROM dependencies WHERE id = ?', id);
  writeHistory(db, {
    itemId: row.toId,
    action: 'dependency-remove',
    before: rowToDep(row),
    source: 'user',
  });
  return { deleted: true, id };
}

// ---------------------------------------------------------------------------
// proposals
// ---------------------------------------------------------------------------

export function rowToProposal(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    ops: JSON.parse(row.ops || '[]'),
    payload: JSON.parse(row.payload || '{}'),
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt ?? null,
  };
}

const VALID_OPS = new Set(['create', 'update', 'delete']);

export function createProposal(db, input = {}, { source = 'ai' } = {}) {
  const title = needString(input.title, 'title', 200, { required: true, allowEmpty: false });
  const summary = needString(input.summary, 'summary', 4000);
  const kind = typeof input.kind === 'string' && input.kind ? input.kind : 'plan';
  const ops = input.ops === undefined ? [] : input.ops;
  if (!Array.isArray(ops)) throw badRequest('ops must be an array');
  const cleanOps = [];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    if (!op || typeof op !== 'object' || !VALID_OPS.has(op.op)) {
      throw badRequest(`ops[${i}] must be { op: create|update|delete }`);
    }
    if (op.op === 'create') {
      if (!op.item || typeof op.item !== 'object') throw badRequest(`ops[${i}].item is required`);
      if (!op.item.title || typeof op.item.title !== 'string') {
        throw badRequest(`ops[${i}].item.title is required`);
      }
    } else if (!op.id || typeof op.id !== 'string') {
      throw badRequest(`ops[${i}].id is required`);
    }
    cleanOps.push(op);
  }
  const id = input.id || makeId('pr');
  const now = nowStamp();
  const expiresAt = input.expiresAt && isValidStamp(input.expiresAt) ? input.expiresAt : null;
  run(
    db,
    `INSERT INTO proposals(id, kind, title, summary, ops, payload, status, createdAt, expiresAt)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    kind,
    title,
    summary,
    JSON.stringify(cleanOps),
    JSON.stringify(input.payload ?? {}),
    input.status && ['draft', 'accepted', 'rejected', 'expired'].includes(input.status)
      ? input.status
      : 'draft',
    now,
    expiresAt,
  );
  writeHistory(db, {
    itemId: null,
    action: 'proposal-create',
    after: { id, title, ops: cleanOps.length },
    source,
  });
  return getProposal(db, id);
}

export function getProposal(db, id) {
  return rowToProposal(get(db, 'SELECT * FROM proposals WHERE id = ?', id));
}

export function listProposals(db, { status } = {}) {
  const rows = status
    ? all(db, 'SELECT * FROM proposals WHERE status = ? ORDER BY createdAt DESC LIMIT 200', status)
    : all(db, 'SELECT * FROM proposals ORDER BY createdAt DESC LIMIT 200');
  return rows.map(rowToProposal);
}

/**
 * 应用 proposal 的 ops。
 * 契约 §1.4 / §2.5：逐条应用，locked=1 的直接跳过并在结果里报告。
 */
export function acceptProposal(db, id, { source = 'ai' } = {}) {
  const proposal = getProposal(db, id);
  if (!proposal) throw notFound(`proposal ${id} not found`, 'PROPOSAL_NOT_FOUND');
  if (proposal.status !== 'draft') {
    throw badRequest(`proposal is ${proposal.status}, not draft`, 'PROPOSAL_NOT_DRAFT');
  }
  const applied = [];
  const skipped = [];
  const errors = [];

  for (let i = 0; i < proposal.ops.length; i += 1) {
    const op = proposal.ops[i];
    try {
      if (op.op === 'create') {
        const item = createItem(
          db,
          { ...op.item, source: op.item.source || 'ai' },
          { source: 'ai', actorSource: 'ai' },
        );
        applied.push({ op: 'create', id: item.id, item });
      } else if (op.op === 'update') {
        const target = getItem(db, op.id);
        if (!target) {
          errors.push({ opIndex: i, id: op.id, reason: 'not-found' });
          continue;
        }
        if (target.locked) {
          skipped.push({ id: op.id, reason: 'locked' });
          continue;
        }
        const item = updateItem(db, op.id, op.patch || {}, { source: 'ai', actorSource: 'ai' });
        applied.push({ op: 'update', id: item.id, item });
      } else if (op.op === 'delete') {
        const target = getItem(db, op.id);
        if (!target) {
          errors.push({ opIndex: i, id: op.id, reason: 'not-found' });
          continue;
        }
        if (target.locked) {
          skipped.push({ id: op.id, reason: 'locked' });
          continue;
        }
        deleteItem(db, op.id, { source: 'ai' });
        applied.push({ op: 'delete', id: op.id });
      }
    } catch (err) {
      if (err && err.code === 'LOCKED') {
        skipped.push({ id: op.id || null, reason: 'locked' });
      } else {
        errors.push({ opIndex: i, id: op.id || null, reason: err && err.message ? err.message : String(err) });
      }
    }
  }

  run(
    db,
    "UPDATE proposals SET status='accepted', payload=? WHERE id=?",
    JSON.stringify({ ...proposal.payload, applied, skipped, errors, appliedAt: nowStamp() }),
    id,
  );
  writeHistory(db, {
    itemId: null,
    action: 'proposal-accept',
    before: { id, status: 'draft' },
    after: { id, applied: applied.length, skipped: skipped.length, errors: errors.length },
    source,
  });
  return { applied, skipped, errors, proposal: getProposal(db, id) };
}

export function rejectProposal(db, id) {
  const proposal = getProposal(db, id);
  if (!proposal) throw notFound(`proposal ${id} not found`, 'PROPOSAL_NOT_FOUND');
  if (proposal.status !== 'draft') {
    throw badRequest(`proposal is ${proposal.status}, not draft`, 'PROPOSAL_NOT_DRAFT');
  }
  run(db, "UPDATE proposals SET status='rejected' WHERE id=?", id);
  writeHistory(db, {
    itemId: null,
    action: 'proposal-reject',
    before: { id, status: 'draft' },
    after: { id, status: 'rejected' },
    source: 'user',
  });
  return getProposal(db, id);
}

// ---------------------------------------------------------------------------
// reminders 行辅助（供 reminders.mjs 复用，避免循环依赖）
// ---------------------------------------------------------------------------

export function rowToReminder(row) {
  if (!row) return null;
  return {
    id: row.id,
    itemId: row.itemId ?? null,
    kind: row.kind,
    title: row.title,
    body: row.body,
    fireAt: row.fireAt,
    status: row.status,
    firedAt: row.firedAt ?? null,
    snoozedTo: row.snoozedTo ?? null,
    repeatOf: row.repeatOf ?? null,
    dedupeKey: row.dedupeKey,
    catchup: Number(row.catchup) || 0,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// prefs / settings
// ---------------------------------------------------------------------------

export function settings(db) {
  const prefs = readPrefs(db);
  // 防御：即使 prefs 里被塞进密钥字段（例如旧备份导入），也绝不通过 API 回显
  return redactSecrets({ ...prefs });
}

function checkPrefValue(key, value) {
  if (SECRET_KEY_RE.test(key)) {
    throw badRequest(`${key} is not an allowed setting key`, 'SECRET_KEY_NOT_ALLOWED');
  }
  const type = PREF_SCHEMA[key];
  if (!type) return value; // 未知键宽松接受（应用可能先行传新字段）
  switch (type) {
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw badRequest(`${key} must be an integer`);
      }
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw badRequest(`${key} must be a number`);
      }
      return value;
    case 'bool':
      if (typeof value !== 'boolean') throw badRequest(`${key} must be a boolean`);
      return value;
    case 'string':
      if (typeof value !== 'string') throw badRequest(`${key} must be a string`);
      return value;
    case 'times':
      if (!Array.isArray(value) || value.some((t) => typeof t !== 'string' || !isValidTime(t))) {
        throw badRequest(`${key} must be an array of HH:mm`);
      }
      return value;
    case 'dnd': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw badRequest(`${key} must be an object`);
      }
      if (value.active !== undefined && typeof value.active !== 'boolean') {
        throw badRequest('dnd.active must be a boolean');
      }
      for (const f of ['from', 'to']) {
        if (value[f] !== undefined && (typeof value[f] !== 'string' || !isValidTime(value[f]))) {
          throw badRequest(`dnd.${f} must be HH:mm`);
        }
      }
      return { ...DEFAULT_PREFS.dnd, ...value };
    }
    case 'notify': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw badRequest(`${key} must be an object`);
      }
      for (const f of ['system', 'pet', 'sound']) {
        if (value[f] !== undefined && typeof value[f] !== 'boolean') {
          throw badRequest(`notify.${f} must be a boolean`);
        }
      }
      return { ...DEFAULT_PREFS.notify, ...value };
    }
    default:
      return value;
  }
}

export function patchSettings(db, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw badRequest('settings patch must be an object');
  }
  const applied = {};
  for (const [key, raw] of Object.entries(patch)) {
    applied[key] = checkPrefValue(key, raw);
  }
  tx(db, () => {
    for (const [key, value] of Object.entries(applied)) writePref(db, key, value);
  });
  return settings(db);
}

// ---------------------------------------------------------------------------
// export / import
// ---------------------------------------------------------------------------

const SECRET_KEY_RE = /(api[_-]?key|secret|password|passwd|token|authorization)/i;

/** 递归剔除密钥字段，保证 /export 不含任何密钥 */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) continue;
      out[k] = redactSecrets(v);
    }
    return out;
  }
  return value;
}

export function exportAll(db, { version = '1.0.0' } = {}) {
  const items = all(db, 'SELECT * FROM items ORDER BY createdAt').map(rowToItem);
  const dependencies = all(db, 'SELECT * FROM dependencies').map(rowToDep);
  const reminders = all(db, 'SELECT * FROM reminders ORDER BY createdAt').map(rowToReminder);
  const prefs = {};
  for (const row of all(db, 'SELECT key, value FROM prefs')) {
    try {
      prefs[row.key] = JSON.parse(row.value);
    } catch {
      prefs[row.key] = row.value;
    }
  }
  const memory = all(db, 'SELECT * FROM memory ORDER BY createdAt');
  const parseMaybeJson = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  const history = all(db, 'SELECT * FROM history ORDER BY at').map((row) => ({
    ...row,
    before: parseMaybeJson(row.before),
    after: parseMaybeJson(row.after),
  }));
  return redactSecrets({
    version,
    exportedAt: nowStamp(),
    items,
    dependencies,
    reminders,
    prefs,
    memory,
    history,
  });
}

function boolInt(v) {
  return v === true || v === 1 || v === '1' ? 1 : 0;
}

function importItemRow(db, row, index) {
  if (!row || typeof row !== 'object' || !row.id || !row.title) {
    throw badRequest(`items[${index}] must have id and title`, 'IMPORT_INVALID');
  }
  const normalized = normalizeItem({ ...row, source: row.source || 'import' }, { db });
  run(
    db,
    `INSERT INTO items(
      id, kind, title, notes, parentId, status, progress, precision,
      startDate, endDate, startTime, endTime, dueDate, fuzzyLabel,
      locked, priority, color, tags, source, createdAt, updatedAt, completedAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.id,
    normalized.kind,
    normalized.title,
    normalized.notes,
    normalized.parentId,
    normalized.status,
    normalized.progress,
    normalized.precision,
    normalized.startDate,
    normalized.endDate,
    normalized.startTime,
    normalized.endTime,
    normalized.dueDate,
    normalized.fuzzyLabel,
    normalized.locked,
    normalized.priority,
    normalized.color,
    JSON.stringify(normalized.tags),
    normalized.source,
    typeof row.createdAt === 'string' ? row.createdAt : nowStamp(),
    typeof row.updatedAt === 'string' ? row.updatedAt : nowStamp(),
    normalized.completedAt,
  );
}

function importItemRowMerge(db, row, index) {
  const existing = get(db, 'SELECT id FROM items WHERE id = ?', row.id);
  if (existing) {
    const merged = { ...row, source: row.source || 'import' };
    const normalized = normalizeItem(merged, { db, selfId: row.id });
    run(
      db,
      `UPDATE items SET kind=?, title=?, notes=?, parentId=?, status=?, progress=?, precision=?,
        startDate=?, endDate=?, startTime=?, endTime=?, dueDate=?, fuzzyLabel=?, locked=?,
        priority=?, color=?, tags=?, source=?, updatedAt=?, completedAt=? WHERE id=?`,
      normalized.kind,
      normalized.title,
      normalized.notes,
      normalized.parentId,
      normalized.status,
      normalized.progress,
      normalized.precision,
      normalized.startDate,
      normalized.endDate,
      normalized.startTime,
      normalized.endTime,
      normalized.dueDate,
      normalized.fuzzyLabel,
      normalized.locked,
      normalized.priority,
      normalized.color,
      JSON.stringify(normalized.tags),
      normalized.source,
      typeof row.updatedAt === 'string' ? row.updatedAt : nowStamp(),
      normalized.completedAt,
      row.id,
    );
    return 'updated';
  }
  importItemRow(db, row, index);
  return 'inserted';
}

/**
 * 导入。
 * mode=replace 会清空 items/dependencies/reminders/prefs/memory/history 后重建；
 * proposals 与 bootEvents 不在契约导出集合里，保持不动。
 */
export function importAll(db, data, { mode = 'replace' } = {}) {
  if (!data || typeof data !== 'object') throw badRequest('import body must be an object');
  if (mode !== 'replace' && mode !== 'merge') throw badRequest('mode must be replace or merge');
  const items = Array.isArray(data.items) ? data.items : [];
  const dependencies = Array.isArray(data.dependencies) ? data.dependencies : [];
  const reminders = Array.isArray(data.reminders) ? data.reminders : [];
  const prefs = data.prefs && typeof data.prefs === 'object' ? data.prefs : {};
  const memory = Array.isArray(data.memory) ? data.memory : [];
  const history = Array.isArray(data.history) ? data.history : [];

  const stats = { mode, items: 0, itemsUpdated: 0, dependencies: 0, reminders: 0, prefs: 0, memory: 0, history: 0 };

  return tx(db, () => {
    db.exec('PRAGMA defer_foreign_keys = ON');
    if (mode === 'replace') {
      run(db, 'DELETE FROM dependencies');
      run(db, 'DELETE FROM reminders');
      run(db, 'DELETE FROM history');
      run(db, 'DELETE FROM items');
      run(db, 'DELETE FROM prefs');
      run(db, 'DELETE FROM memory');
    }

    // 父节点先于子节点插入，避免外键顺序问题（defer_foreign_keys 已兜底）
    const pending = [...items];
    const inserted = new Set();
    const existingIds = new Set(
      all(db, 'SELECT id FROM items').map((r) => r.id),
    );
    let guard = 0;
    while (pending.length && guard < items.length * 3 + 10) {
      guard += 1;
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const row = pending[i];
        const parentOk =
          !row.parentId || inserted.has(row.parentId) || existingIds.has(row.parentId);
        if (!parentOk) continue;
        pending.splice(i, 1);
        const action = mode === 'merge' ? importItemRowMerge(db, row, i) : importItemRow(db, row, i);
        inserted.add(row.id);
        existingIds.add(row.id);
        if (action === 'updated') stats.itemsUpdated += 1;
        else stats.items += 1;
      }
      // 父节点缺失的孤儿：放宽 parentId 后再插，避免整包失败
      if (pending.length) {
        for (const row of pending) {
          if (row.parentId && !existingIds.has(row.parentId) && !inserted.has(row.parentId)) {
            row.parentId = null;
          }
        }
      }
    }
    if (pending.length) {
      throw badRequest('import contains items with unresolvable parent references', 'IMPORT_INVALID');
    }

    for (const dep of dependencies) {
      if (!dep || !dep.fromId || !dep.toId || dep.fromId === dep.toId) continue;
      if (!get(db, 'SELECT 1 AS x FROM items WHERE id = ?', dep.fromId)) continue;
      if (!get(db, 'SELECT 1 AS x FROM items WHERE id = ?', dep.toId)) continue;
      run(
        db,
        'INSERT OR IGNORE INTO dependencies(id, fromId, toId, type) VALUES (?,?,?,?)',
        dep.id || makeId('d'),
        dep.fromId,
        dep.toId,
        DEP_TYPES.includes(dep.type) ? dep.type : 'finish-to-start',
      );
      stats.dependencies += 1;
    }

    for (const rem of reminders) {
      if (!rem || !rem.dedupeKey || !rem.fireAt) continue;
      if (!isValidStamp(rem.fireAt)) continue;
      const insertedRow = run(
        db,
        `INSERT OR IGNORE INTO reminders(
          id, itemId, kind, title, body, fireAt, status, firedAt, snoozedTo, repeatOf, dedupeKey, catchup, createdAt
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        rem.id || makeId('r'),
        rem.itemId || null,
        rem.kind || 'custom',
        rem.title || '提醒',
        rem.body || '',
        rem.fireAt,
        rem.status || 'pending',
        rem.firedAt || null,
        rem.snoozedTo || null,
        rem.repeatOf || null,
        rem.dedupeKey,
        boolInt(rem.catchup),
        rem.createdAt || nowStamp(),
      );
      if (insertedRow.changes > 0) stats.reminders += 1;
    }

    for (const [key, value] of Object.entries(prefs)) {
      writePref(db, key, value);
      stats.prefs += 1;
    }

    for (const m of memory) {
      if (!m || !m.text) continue;
      run(
        db,
        `INSERT OR REPLACE INTO memory(id, kind, text, confidence, source, createdAt, expiresAt)
         VALUES (?,?,?,?,?,?,?)`,
        m.id || makeId('mem'),
        m.kind || 'preference',
        m.text,
        typeof m.confidence === 'number' ? m.confidence : 0.5,
        m.source || 'import',
        m.createdAt || nowStamp(),
        m.expiresAt || null,
      );
      stats.memory += 1;
    }

    for (const h of history) {
      if (!h || !h.action) continue;
      run(
        db,
        `INSERT OR REPLACE INTO history(id, itemId, at, action, before, after, source)
         VALUES (?,?,?,?,?,?,?)`,
        h.id || makeId('h'),
        h.itemId || null,
        h.at || nowStamp(),
        h.action,
        h.before == null ? null : typeof h.before === 'string' ? h.before : JSON.stringify(h.before),
        h.after == null ? null : typeof h.after === 'string' ? h.after : JSON.stringify(h.after),
        h.source || 'import',
      );
      stats.history += 1;
    }

    writeHistory(db, { itemId: null, action: `import-${mode}`, after: stats, source: 'import' });
    return stats;
  });
}

// ---------------------------------------------------------------------------
// 计算辅助
// ---------------------------------------------------------------------------

/** 粗估工作量（分钟）：slot 用真实时长，day 记 240，其它按 60 */
export function estimateMinutes(item) {
  if (!item) return 60;
  if (item.precision === 'slot' && item.startTime && item.endTime) {
    const s = parseTime(item.startTime);
    const e = parseTime(item.endTime);
    return Math.max(15, e.h * 60 + e.m - (s.h * 60 + s.m));
  }
  if (item.precision === 'day') return 240;
  if (item.kind === 'milestone') return 120;
  return 60;
}

export function daysUntil(dueDate, now = today()) {
  if (!dueDate) return null;
  return diffDays(now, dueDate);
}

/** 5 天内到期但没排时间的任务（窗口的待安排池候选） */
export function unscheduledCandidates(db, { days = 5, now = today() } = {}) {
  const horizon = addDays(now, days);
  const rows = all(
    db,
    `SELECT * FROM items
     WHERE status NOT IN ('done','cancelled')
       AND (precision = 'unscheduled'
            OR (precision = 'slot' AND (startTime IS NULL OR endTime IS NULL))
            OR (precision = 'day' AND startDate IS NULL))
     ORDER BY CASE WHEN dueDate IS NULL THEN 1 ELSE 0 END, dueDate ASC, priority DESC, createdAt ASC`,
  ).map(rowToItem);
  return rows.map((item) => ({
    item,
    reason: item.dueDate && item.dueDate <= horizon ? 'due-soon' : 'unscheduled',
    dueInDays: item.dueDate ? diffDays(now, item.dueDate) : null,
  }));
}
