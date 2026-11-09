// 提醒：生成、去重、补发、snooze、以及喝水/休息/饭点的定时调度。
//
// 不变量（docs/API.md §1.3 / §3）：
//  1. dedupeKey 唯一，同一 key 永不二次入队（INSERT ... ON CONFLICT DO NOTHING）；
//  2. 任务 done/cancelled 后其 pending 提醒立即 cancelled；
//  3. 服务重启补发 fireAt<=now 的 pending，>24h 的 start 提醒作废，且不重复弹；
//  4. snooze 一律生成新提醒行，repeatOf 指向原提醒，snoozedTo 正确。
import {
  addMinutesToStamp,
  fmtDate,
  isValidStamp,
  isValidTime,
  minutesOfDay,
  nowStamp,
  parseStamp,
  parseTime,
  today,
  addDays,
} from './time.mjs';
import { get, all, run, writePref } from './db.mjs';
import { badRequest, notFound, conflictError } from './errors.mjs';
import { getItem, rowToReminder, makeId, setProgress } from './model.mjs';

export const REMINDER_KINDS = [
  'start', 'end', 'due', 'water', 'rest', 'meal', 'custom', 'boot',
];
export const REMINDER_STATUSES = [
  'pending', 'fired', 'acked', 'snoozed', 'dismissed', 'cancelled', 'done',
];
const DUE_ACTIONS = ['start', 'done', 'snooze', 'skip', 'open'];

// ---------------------------------------------------------------------------
// 底层写入
// ---------------------------------------------------------------------------

function insertIfAbsent(db, r) {
  const createdAt = r.createdAt || nowStamp();
  const res = run(
    db,
    `INSERT INTO reminders(
      id, itemId, kind, title, body, fireAt, status, firedAt, snoozedTo, repeatOf, dedupeKey, catchup, createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(dedupeKey) DO NOTHING`,
    r.id || makeId('r'),
    r.itemId || null,
    r.kind,
    r.title,
    r.body || '',
    r.fireAt,
    r.status || 'pending',
    r.firedAt || null,
    r.snoozedTo || null,
    r.repeatOf || null,
    r.dedupeKey,
    r.catchup ? 1 : 0,
    createdAt,
  );
  const row = get(db, 'SELECT * FROM reminders WHERE dedupeKey = ?', r.dedupeKey);
  return { inserted: res.changes > 0, reminder: rowToReminder(row) };
}

export function getReminder(db, id) {
  return rowToReminder(get(db, 'SELECT * FROM reminders WHERE id = ?', id));
}

export function listReminders(db, { status, kind, itemId, limit } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  if (itemId) {
    where.push('itemId = ?');
    params.push(itemId);
  }
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const sql = `SELECT * FROM reminders ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY fireAt ASC, createdAt ASC LIMIT ?`;
  return all(db, sql, ...params, lim).map(rowToReminder);
}

export function countReminders(db) {
  const pending = get(db, "SELECT COUNT(*) AS c FROM reminders WHERE status = 'pending'");
  const fired = get(db, "SELECT COUNT(*) AS c FROM reminders WHERE status IN ('fired','acked','done')");
  return {
    pending: pending ? Number(pending.c) : 0,
    fired: fired ? Number(fired.c) : 0,
  };
}

export function createManualReminder(db, input = {}) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw badRequest('title is required');
  if (title.length > 120) throw badRequest('title must be <= 120 chars');
  if (!isValidStamp(input.fireAt)) throw badRequest('fireAt must be YYYY-MM-DDTHH:mm:ss');
  const kind = input.kind || 'custom';
  if (!REMINDER_KINDS.includes(kind)) throw badRequest(`kind must be one of: ${REMINDER_KINDS.join(', ')}`);
  if (input.itemId && !getItem(db, input.itemId)) {
    throw badRequest(`item ${input.itemId} not found`, 'ITEM_NOT_FOUND');
  }
  const dedupeKey =
    typeof input.dedupeKey === 'string' && input.dedupeKey.trim()
      ? input.dedupeKey.trim()
      : `custom:${makeId('c')}`;
  const { reminder, inserted } = insertIfAbsent(db, {
    itemId: input.itemId || null,
    kind,
    title,
    body: typeof input.body === 'string' ? input.body.slice(0, 500) : '',
    fireAt: input.fireAt,
    dedupeKey,
  });
  return { ...reminder, inserted };
}

// ---------------------------------------------------------------------------
// 开机邀请提醒
// ---------------------------------------------------------------------------

/**
 * 生成/更新"稍后再说"这类 boot 提醒。
 * dedupeKey 固定，所以不会因为重复点击产生多行；但用户再次点 later 时
 * 会把同一条的目的时间往后推（这是显式用户操作，不算自动重复入队）。
 */
export function ensureBootReminder(db, { sessionId, fireAt, title, body, dedupeKey }) {
  if (!isValidStamp(fireAt)) throw badRequest('fireAt must be YYYY-MM-DDTHH:mm:ss');
  const key = dedupeKey || `boot:${sessionId}:later`;
  const existing = rowToReminder(get(db, 'SELECT * FROM reminders WHERE dedupeKey = ?', key));
  if (existing) {
    if (existing.status === 'pending') {
      // 还在队列里：只改时间，不算二次入队
      run(
        db,
        'UPDATE reminders SET fireAt = ?, title = ?, body = ? WHERE id = ?',
        fireAt,
        title,
        body || '',
        existing.id,
      );
      return getReminder(db, existing.id);
    }
    // 已经弹过/被关掉：用新 dedupeKey 生成新提醒，遵守"同一 key 永不二次入队"
    const { reminder } = insertIfAbsent(db, {
      itemId: null,
      kind: 'boot',
      title,
      body: body || '',
      fireAt,
      dedupeKey: `${key}:${makeId('r')}`,
    });
    return reminder;
  }
  const { reminder } = insertIfAbsent(db, {
    itemId: null,
    kind: 'boot',
    title,
    body: body || '',
    fireAt,
    dedupeKey: key,
  });
  return reminder;
}

export function cancelBootReminders(db, sessionId) {
  const prefix = `boot:${sessionId}:`;
  const rows = all(
    db,
    "SELECT * FROM reminders WHERE kind = 'boot' AND status = 'pending'",
  );
  let n = 0;
  for (const row of rows) {
    if (typeof row.dedupeKey === 'string' && row.dedupeKey.startsWith(prefix)) {
      run(db, "UPDATE reminders SET status='cancelled' WHERE id=?", row.id);
      n += 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// 任务提醒
// ---------------------------------------------------------------------------

export function cancelPendingForItem(db, itemId, kinds = ['start', 'end', 'due']) {
  if (!itemId || kinds.length === 0) return 0;
  const placeholders = kinds.map(() => '?').join(',');
  const res = run(
    db,
    `UPDATE reminders SET status = 'cancelled'
     WHERE itemId = ? AND status = 'pending' AND kind IN (${placeholders})`,
    itemId,
    ...kinds,
  );
  return res.changes || 0;
}

function itemReminderText(item, kind) {
  const when = item.startDate ? `${item.startDate} ${item.startTime || ''}-${item.endTime || ''}`.trim() : '';
  if (kind === 'start') {
    return {
      title: `开始：${item.title}`,
      body: `${when}${item.notes ? `\n${item.notes.slice(0, 200)}` : ''}`,
    };
  }
  if (kind === 'end') {
    return { title: `结束：${item.title}`, body: `${when} 到点了，收个尾。` };
  }
  return {
    title: `到期：${item.title}`,
    body: `${item.dueDate} 到期，当前进度 ${item.progress}%。`,
  };
}

/**
 * 同步一个 item 的提醒：
 *  - done/cancelled → 撤销 pending start/end/due；
 *  - slot → start/end 提醒；
 *  - 有 dueDate → 当天 09:00 的 due 提醒。
 * 幂等：重复调用不会生成重复行。
 */
export function syncItemReminders(db, item, { prefs, now = new Date() } = {}) {
  if (!item) return { created: 0 };
  const nowS = nowStamp(now);
  const created = [];
  const cancelled = [];

  if (item.status === 'done' || item.status === 'cancelled') {
    const n = cancelPendingForItem(db, item.id);
    if (n) cancelled.push(n);
    return { created: 0, cancelled: n };
  }

  const taskReminder = prefs ? prefs.taskReminder !== false : true;
  if (!taskReminder) return { created: 0, cancelled: 0 };

  // 重新排期后，旧的 pending start/end 必须跟着变：
  //  - 换了日期/精度 → dedupeKey 变了 → 撤掉旧的
  //  - 同一天内只改了时刻 → dedupeKey 不变 → 原地更新 fireAt（否则会按旧时间提醒）
  const expectedStart = item.precision === 'slot' && item.startDate && item.startTime
    ? `item:${item.id}:start:${item.startDate}`
    : null;
  const expectedEnd = item.precision === 'slot' && item.startDate && item.endTime
    ? `item:${item.id}:end:${item.startDate}`
    : null;
  const wantStartAt = expectedStart ? `${item.startDate}T${item.startTime}:00` : null;
  const wantEndAt = expectedEnd ? `${item.startDate}T${item.endTime}:00` : null;
  let rescheduled = 0;
  const pending = all(
    db,
    "SELECT * FROM reminders WHERE itemId = ? AND status = 'pending' AND kind IN ('start','end')",
    item.id,
  );
  for (const row of pending) {
    const want = row.kind === 'start' ? expectedStart : expectedEnd;
    const wantAt = row.kind === 'start' ? wantStartAt : wantEndAt;
    if (!want || row.dedupeKey !== want) {
      run(db, "UPDATE reminders SET status='cancelled' WHERE id = ?", row.id);
      cancelled.push(1);
      continue;
    }
    if (wantAt && row.fireAt !== wantAt) {
      const text = itemReminderText(item, row.kind);
      run(
        db,
        "UPDATE reminders SET fireAt = ?, title = ?, body = ?, snoozedTo = NULL WHERE id = ?",
        wantAt, text.title, text.body, row.id,
      );
      rescheduled += 1;
    }
  }

  if (expectedStart) {
    const text = itemReminderText(item, 'start');
    const r = insertIfAbsent(db, {
      itemId: item.id,
      kind: 'start',
      title: text.title,
      body: text.body,
      fireAt: `${item.startDate}T${item.startTime}:00`,
      dedupeKey: expectedStart,
    });
    if (r.inserted) created.push(r.reminder);
  }
  if (expectedEnd) {
    const text = itemReminderText(item, 'end');
    const r = insertIfAbsent(db, {
      itemId: item.id,
      kind: 'end',
      title: text.title,
      body: text.body,
      fireAt: `${item.startDate}T${item.endTime}:00`,
      dedupeKey: expectedEnd,
    });
    if (r.inserted) created.push(r.reminder);
  }

  if (item.dueDate) {
    // 只给今天及以后的到期日建提醒；当天 09:00 已过则立即补一次（仍遵守 dedupeKey 唯一）
    const dueKey = `item:${item.id}:due:${item.dueDate}`;
    const dueAt = `${item.dueDate}T09:00:00`;
    if (item.dueDate >= today(now)) {
      const fireAt = dueAt > nowS ? dueAt : nowS;
      const text = itemReminderText(item, 'due');
      const r = insertIfAbsent(db, {
        itemId: item.id,
        kind: 'due',
        title: text.title,
        body: text.body,
        fireAt,
        dedupeKey: dueKey,
      });
      if (r.inserted) created.push(r.reminder);
    }
  }

  return { created: created.length, cancelled: cancelled.length, rescheduled };
}

/** 为窗口内的 slot / due 项补齐提醒（tick 与启动都会调用，幂等） */
export function syncWindowReminders(db, { prefs, now = new Date(), horizonDays = 14 } = {}) {
  const start = today(now);
  const end = addDays(start, horizonDays);
  const rows = all(
    db,
    `SELECT id FROM items
     WHERE status NOT IN ('done','cancelled')
       AND ((precision = 'slot' AND startDate BETWEEN ? AND ?)
            OR (dueDate BETWEEN ? AND ?))`,
    start,
    end,
    start,
    end,
  );
  let created = 0;
  for (const row of rows) {
    const item = getItem(db, row.id);
    if (!item) continue;
    const r = syncItemReminders(db, item, { prefs, now });
    created += r.created;
  }
  return { scanned: rows.length, created };
}

// ---------------------------------------------------------------------------
// 免打扰
// ---------------------------------------------------------------------------

function windowContains(from, to, nowMin) {
  const f = minutesOfDay(from);
  const t = minutesOfDay(to);
  if (f === null || t === null) return false;
  if (f === t) return true;
  if (f < t) return nowMin >= f && nowMin < t;
  return nowMin >= f || nowMin < t; // 跨午夜
}

export function dndState(db, prefs, now = new Date()) {
  const dnd = (prefs && prefs.dnd) || { active: false, from: '23:00', to: '07:00' };
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowS = nowStamp(now);
  if (dnd.active) {
    let until = null;
    let reason = 'manual';
    if (dnd.until && isValidTime(dnd.until)) {
      const u = parseTime(dnd.until);
      const untilMin = u.h * 60 + u.m;
      const sameDay = untilMin > nowMin;
      until = `${addDays(fmtDate(now), sameDay ? 0 : 1)}T${dnd.until}:00`;
      reason = 'manual';
    } else if (dnd.to && isValidTime(dnd.to)) {
      const t = parseTime(dnd.to);
      const untilMin = t.h * 60 + t.m;
      const sameDay = untilMin > nowMin;
      until = `${addDays(fmtDate(now), sameDay ? 0 : 1)}T${dnd.to}:00`;
      reason = 'schedule';
    }
    if (until && until <= nowS) until = null;
    return { active: true, until, reason };
  }
  if (windowContains(dnd.from, dnd.to, nowMin)) {
    const t = parseTime(dnd.to);
    const untilMin = t.h * 60 + t.m;
    const sameDay = untilMin > nowMin;
    return {
      active: true,
      until: `${addDays(fmtDate(now), sameDay ? 0 : 1)}T${dnd.to}:00`,
      reason: 'schedule',
    };
  }
  return { active: false, until: null, reason: null };
}

function deferStamp(db, prefs, now, baseStamp) {
  const state = dndState(db, prefs, now);
  if (!state.active) return baseStamp;
  if (state.until && state.until > baseStamp) return state.until;
  return baseStamp;
}

// ---------------------------------------------------------------------------
// 喝水 / 休息 / 饭点
// ---------------------------------------------------------------------------

function latestOfKind(db, kind) {
  return rowToReminder(
    get(
      db,
      'SELECT * FROM reminders WHERE kind = ? ORDER BY fireAt DESC, createdAt DESC LIMIT 1',
      kind,
    ),
  );
}

function pendingOfKind(db, kind) {
  return rowToReminder(
    get(db, "SELECT * FROM reminders WHERE kind = ? AND status='pending' ORDER BY fireAt ASC LIMIT 1", kind),
  );
}

function waterTick(db, prefs, now) {
  const every = Number(prefs.waterEveryMin) || 0;
  if (every <= 0) return null;
  if (pendingOfKind(db, 'water')) return null;
  const last = latestOfKind(db, 'water');
  if (!last) return null; // 冷启动先建立锚点，不刚开机就催喝水
  const lastAt = parseStamp(last.fireAt);
  if (!lastAt) return null;
  const elapsedMin = (now.getTime() - lastAt.getTime()) / 60000;
  if (elapsedMin < every) return null;
  const fireAt = deferStamp(db, prefs, now, nowStamp(now));
  const keyTime = fireAt.slice(0, 16); // YYYY-MM-DDTHH:mm
  return insertIfAbsent(db, {
    kind: 'water',
    title: '喝水时间',
    body: `距上次喝水已 ${Math.round(elapsedMin)} 分钟，起来喝一杯。`,
    fireAt,
    dedupeKey: `water:${keyTime}`,
  });
}

function restTick(db, prefs, now) {
  const every = Number(prefs.restEveryMin) || 0;
  const length = Number(prefs.restLengthMin) || 10;
  if (every <= 0) return null;
  if (pendingOfKind(db, 'rest')) return null;

  let sessionStart = null;
  let sessionKey = null;
  const focus = prefs.focus;
  if (focus && focus.active && isValidStamp(focus.startedAt)) {
    // 专注会话必须还在有效期内、且属于今天：
    // 否则昨天点了"专注 45 分钟"没结束，今天上班会被算成"连续工作 757 分钟"
    const plannedEnd = isValidStamp(focus.plannedEndAt) ? parseStamp(focus.plannedEndAt) : null;
    const stillRunning = !plannedEnd || plannedEnd.getTime() > now.getTime();
    const sameDay = String(focus.startedAt).slice(0, 10) === fmtDate(now);
    if (stillRunning && sameDay) {
      sessionStart = parseStamp(focus.startedAt);
      sessionKey = `focus:${focus.startedAt}`;
    }
  }
  if (!sessionStart) {
    // 没有显式专注时：正在进行的 slot 任务视为工作会话
    const nowS = nowStamp(now);
    const row = get(
      db,
      `SELECT * FROM items
       WHERE status NOT IN ('done','cancelled') AND precision='slot' AND startDate = ?
         AND startTime IS NOT NULL AND endTime IS NOT NULL
         AND ? >= (startDate || 'T' || startTime || ':00')
         AND ? <  (startDate || 'T' || endTime || ':00')
       ORDER BY startTime ASC LIMIT 1`,
      fmtDate(now),
      nowS,
      nowS,
    );
    if (row) {
      sessionStart = parseStamp(`${row.startDate}T${row.startTime}:00`);
      sessionKey = `slot:${row.id}:${row.startDate}T${row.startTime}`;
    }
  }

  // 兜底：既没开专注、也没有正在进行的具体时段任务时，
  // 按"今天这个工作时段"计时（每 50 分钟提醒一次休息），
  // 但绝不跨天累计——避免出现"连续工作 757 分钟"这种荒谬数字。
  if (!sessionStart) {
    const ws = prefs.workSessionStart;
    if (isValidStamp(ws) && String(ws).slice(0, 10) === fmtDate(now)) {
      sessionStart = parseStamp(ws);
      sessionKey = `day:${fmtDate(now)}`;
    }
  }
  if (!sessionStart || !sessionKey) return null;

  const elapsed = (now.getTime() - sessionStart.getTime()) / 60000;
  if (elapsed < every) return null;
  const cycle = every + length;
  const round = Math.max(1, Math.floor(elapsed / cycle) + (elapsed % cycle >= every ? 1 : 0));
  const dedupeKey = `rest:${sessionKey}:${round}`;
  const existing = get(db, 'SELECT 1 AS x FROM reminders WHERE dedupeKey = ?', dedupeKey);
  if (existing) return null;
  const fireAt = deferStamp(db, prefs, now, nowStamp(now));
  return insertIfAbsent(db, {
    kind: 'rest',
    title: '该休息一下了',
    body: `已经连续工作 ${Math.round(elapsed)} 分钟，休息 ${length} 分钟再继续。`,
    fireAt,
    dedupeKey,
  });
}

function mealLabel(meal) {
  const mins = minutesOfDay(meal);
  if (mins === null) return '用餐';
  if (mins < 14 * 60) return '午饭';
  if (mins >= 17 * 60) return '晚饭';
  return '用餐';
}

function mealTick(db, prefs, now) {
  const meals = Array.isArray(prefs.meals) ? prefs.meals : [];
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const date = fmtDate(now);
  const out = [];
  for (const meal of meals) {
    if (!isValidTime(meal)) continue;
    const m = minutesOfDay(meal);
    if (nowMin < m || nowMin > m + 45) continue;
    const key = `meal:${date}:${meal}`;
    if (get(db, 'SELECT 1 AS x FROM reminders WHERE dedupeKey = ?', key)) continue;
    const fireAt = deferStamp(db, prefs, now, nowStamp(now));
    const r = insertIfAbsent(db, {
      kind: 'meal',
      title: `${mealLabel(meal)}时间`,
      body: `到 ${meal} 了，先吃饭，回来再继续。`,
      fireAt,
      dedupeKey: key,
    });
    if (r.inserted) out.push(r.reminder);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 弹出队列 / ack / snooze
// ---------------------------------------------------------------------------

export function listDue(db, { now = new Date(), limit = 20 } = {}) {
  const nowS = nowStamp(now);
  const rows = all(
    db,
    "SELECT * FROM reminders WHERE status = 'pending' AND fireAt <= ? ORDER BY fireAt ASC, createdAt ASC LIMIT ?",
    nowS,
    Math.min(Math.max(Number(limit) || 20, 1), 100),
  );
  const fired = [];
  for (const row of rows) {
    const res = run(
      db,
      "UPDATE reminders SET status='fired', firedAt=COALESCE(firedAt, ?) WHERE id = ? AND status='pending'",
      nowS,
      row.id,
    );
    if (res.changes > 0) {
      fired.push({
        ...rowToReminder(get(db, 'SELECT * FROM reminders WHERE id = ?', row.id)),
        actions: DUE_ACTIONS,
      });
    }
  }
  return { items: fired, now: nowS };
}

function snoozeReminder(db, original, snoozeMin) {
  const minutes = Number.isFinite(Number(snoozeMin)) && Number(snoozeMin) > 0 ? Number(snoozeMin) : 30;
  const fireAt = addMinutesToStamp(nowStamp(), minutes);
  const newId = makeId('r');
  const dedupeKey = `snooze:${original.id}:${fireAt.replace(/[: ]/g, '')}`;
  const { reminder, inserted } = insertIfAbsent(db, {
    id: newId,
    itemId: original.itemId,
    kind: original.kind,
    title: original.title,
    body: original.body,
    fireAt,
    status: 'pending',
    repeatOf: original.id,
    dedupeKey,
    snoozedTo: fireAt,
  });
  run(
    db,
    "UPDATE reminders SET status='snoozed', snoozedTo=? WHERE id=?",
    fireAt,
    original.id,
  );
  return { reminder, inserted, fireAt, snoozeMin: minutes, repeatOf: original.id };
}

export function ackReminder(db, id, { action, snoozeMin } = {}) {
  const original = getReminder(db, id);
  if (!original) throw notFound(`reminder ${id} not found`, 'REMINDER_NOT_FOUND');
  if (!action) throw badRequest('action is required');
  if (!DUE_ACTIONS.includes(action)) {
    throw badRequest(`action must be one of: ${DUE_ACTIONS.join(', ')}`);
  }
  if (['cancelled'].includes(original.status)) {
    throw conflictError('reminder is cancelled', 'REMINDER_CANCELLED');
  }

  if (action === 'snooze') {
    const r = snoozeReminder(db, original, snoozeMin);
    return {
      ok: true,
      action,
      original: getReminder(db, id),
      reminder: r.reminder,
      snoozedTo: r.fireAt,
      repeatOf: original.id,
    };
  }

  const nextStatus =
    action === 'start' ? 'acked' : action === 'done' ? 'done' : 'dismissed';
  run(db, 'UPDATE reminders SET status = ? WHERE id = ?', nextStatus, id);

  let itemUpdated = null;
  if (action === 'done' && original.itemId) {
    try {
      itemUpdated = setProgress(db, original.itemId, { progress: 100, status: 'done' }, { source: 'user' });
      cancelPendingForItem(db, original.itemId);
    } catch {
      itemUpdated = null;
    }
  }

  return { ok: true, action, reminder: getReminder(db, id), item: itemUpdated };
}

export function waterAck(db) {
  const pending = all(
    db,
    "SELECT * FROM reminders WHERE status='pending' AND kind IN ('water','rest') ORDER BY fireAt ASC",
  );
  for (const row of pending) {
    run(db, "UPDATE reminders SET status='acked' WHERE id=?", row.id);
  }
  return { ok: true, acked: pending.length, ids: pending.map((r) => r.id) };
}

// ---------------------------------------------------------------------------
// 补发
// ---------------------------------------------------------------------------

/**
 * 启动补发：
 *  - pending 且 fireAt<=now 的保持 pending，标记 catchup=1，交给 /reminders/due 弹一次；
 *  - 超过 24h 的 start 提醒作废（cancelled），避免开机弹一堆过期任务。
 * 不写新行、不改 fireAt，因此不会重复弹。
 */
export function catchUp(db, { now = new Date() } = {}) {
  const nowS = nowStamp(now);
  const threshold = addMinutesToStamp(nowS, -24 * 60);
  const stale = run(
    db,
    `UPDATE reminders SET status='cancelled', catchup=1
     WHERE status='pending' AND kind='start' AND fireAt < ?`,
    threshold,
  );
  const marked = run(
    db,
    `UPDATE reminders SET catchup=1
     WHERE status='pending' AND fireAt <= ? AND catchup = 0`,
    nowS,
  );
  const pending = get(
    db,
    "SELECT COUNT(*) AS c FROM reminders WHERE status='pending' AND fireAt <= ?",
    nowS,
  );
  return {
    cancelledStale: stale.changes || 0,
    markedCatchup: marked.changes || 0,
    duePending: pending ? Number(pending.c) : 0,
  };
}

// ---------------------------------------------------------------------------
// 调度器
// ---------------------------------------------------------------------------

export function createScheduler({ db, prefsRef, log = () => {}, tickMs = 20000, nowFn = () => new Date() }) {
  const state = {
    tickMs,
    started: false,
    ticks: 0,
    lastTickAt: null,
    lastError: null,
    catchUp: null,
  };
  let timer = null;

  const currentPrefs = () => (typeof prefsRef === 'function' ? prefsRef() : prefsRef) || {};

  // 专注到点自动收尾：否则 active 会一直为 true，休息计时会从很久以前算起
  function expireFocus(prefs, now) {
    try {
      const focus = prefs.focus;
      if (!focus || !focus.active) return false;
      const end = isValidStamp(focus.plannedEndAt) ? parseStamp(focus.plannedEndAt) : null;
      const stale = end ? end.getTime() <= now.getTime() : String(focus.startedAt || '').slice(0, 10) !== fmtDate(now);
      if (!stale) return false;
      const next = { ...focus, active: false, endedAt: nowStamp(now), endReason: 'expired' };
      writePref(db, 'focus', next);
      if (typeof prefsRef === 'function' && prefsRef && prefsRef.set) prefsRef.set(next);
      log('info', 'focus expired, auto-ended');
      return true;
    } catch (err) {
      log('warn', 'expireFocus failed: ' + (err && err.message ? err.message : err));
      return false;
    }
  }

  function tick() {
    const now = nowFn();
    const prefs = currentPrefs();
    const result = { at: nowStamp(now), created: 0 };
    try {
      if (expireFocus(prefs, now)) prefs.focus = { ...(prefs.focus || {}), active: false };
      // 每天第一次运转时记一个"工作时段起点"，供休息计时兜底用
      const todayStr = fmtDate(now);
      if (!isValidStamp(prefs.workSessionStart) || String(prefs.workSessionStart).slice(0, 10) !== todayStr) {
        const stamp = nowStamp(now);
        writePref(db, 'workSessionStart', stamp);
        prefs.workSessionStart = stamp;
      }
      const synced = syncWindowReminders(db, { prefs, now });
      result.created += synced.created;
      const water = waterTick(db, prefs, now);
      if (water && water.inserted) result.created += 1;
      const rest = restTick(db, prefs, now);
      if (rest && rest.inserted) result.created += 1;
      const meals = mealTick(db, prefs, now);
      result.created += meals.length;
      state.ticks += 1;
      state.lastTickAt = result.at;
      state.lastError = null;
      return result;
    } catch (err) {
      state.lastError = err && err.message ? err.message : String(err);
      log('error', `scheduler tick failed: ${state.lastError}`);
      return { at: result.at, error: state.lastError };
    }
  }

  function start() {
    if (state.started) return;
    state.started = true;
    try {
      state.catchUp = catchUp(db, { now: nowFn() });
      log('info', `reminder catch-up: ${JSON.stringify(state.catchUp)}`);
    } catch (err) {
      state.lastError = err && err.message ? err.message : String(err);
      log('error', `catch-up failed: ${state.lastError}`);
    }
    tick();
    timer = setInterval(() => {
      try {
        tick();
      } catch (err) {
        // 双保险：定时器回调里绝不允许异常冒出去
        state.lastError = err && err.message ? err.message : String(err);
        log('error', `scheduler interval error: ${state.lastError}`);
      }
    }, tickMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    state.started = false;
  }

  return { start, stop, tick, state };
}
