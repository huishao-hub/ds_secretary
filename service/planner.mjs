// 规划算法：5 天窗口、冲突检测、时间轴、情景推演。
// 全部是确定性计算，不调用模型、不写库（simulate 契约要求"不修改任何数据"）。
import crypto from 'node:crypto';
import { all, get } from './db.mjs';
import {
  addDays,
  diffDays,
  endOfWeekSunday,
  isValidDate,
  minutesOfDay,
  monthRange,
  nowStamp,
  parseDate,
  quarterOf,
  quarterRange,
  startOfWeekMonday,
  timeFromMinutes,
  today,
  weekdayLabel,
} from './time.mjs';
import { estimateMinutes, rowToItem, unscheduledCandidates } from './model.mjs';

export const OVERLOAD_MIN = 360; // 单日 >6 小时算超载（契约）
export const DAY_START_MIN = 8 * 60; // 夜间 00:00–08:00 不排
export const DAY_END_MIN = 22 * 60; // 22:00 之后不再建议安排（深夜不排活）

function shortHash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
}

function conflict(idSeed, type, severity, itemIds, message, suggestion, extra = {}) {
  return {
    id: `c_${type}_${shortHash(idSeed)}`,
    type,
    severity,
    itemIds,
    message,
    suggestion,
    ...extra,
  };
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

// ---------------------------------------------------------------------------
// 5 天窗口
// ---------------------------------------------------------------------------

function busyIntervalsForDay(items) {
  const out = [];
  for (const item of items) {
    if (item.precision !== 'slot' || item.status === 'cancelled') continue;
    if (!item.startTime || !item.endTime) continue;
    out.push({ id: item.id, start: item.startTime, end: item.endTime, title: item.title });
  }
  return out;
}

export function freeSlotsForDay(busy, slotMinutes) {
  const step = Math.max(5, Math.min(240, Number(slotMinutes) || 30));
  const slots = [];
  for (let m = DAY_START_MIN; m + step <= DAY_END_MIN; m += step) {
    const s = timeFromMinutes(m);
    const e = timeFromMinutes(m + step);
    const blocked = busy.some((b) => {
      const bs = minutesOfDay(b.start);
      const be = minutesOfDay(b.end);
      return bs < m + step && be > m;
    });
    if (!blocked) slots.push({ start: s, end: e, min: step });
  }
  return slots;
}

function dayLoadMin(items) {
  let total = 0;
  for (const item of items) {
    if (item.precision !== 'slot') continue;
    if (item.status === 'done' || item.status === 'cancelled') continue;
    total += estimateMinutes(item);
  }
  return total;
}

/**
 * GET /window 的数据。
 * 说明（实现备注）：每日 items 只放"当天有实体安排或当天到期"的条目；
 * 年度/季度等模糊区间的目标不会铺满每一天，它们在 /timeline 与 /conflicts(no-execution) 里体现。
 */
export function buildWindow(db, { days = 5, from = null, prefs = {}, now = new Date() } = {}) {
  const n = Math.max(1, Math.min(14, Number(days) || Number(prefs.fineWindowDays) || 5));
  const startDate = from && isValidDate(from) ? from : today(now);
  const endDate = addDays(startDate, n - 1);
  const slotMinutes = Math.max(5, Math.min(240, Number(prefs.slotMinutes) || 30));

  const rows = all(
    db,
    `SELECT * FROM items
     WHERE status != 'cancelled'
       AND (
         (startDate IS NOT NULL AND startDate <= ? AND endDate >= ?)
         OR (dueDate IS NOT NULL AND dueDate BETWEEN ? AND ?)
       )
     ORDER BY startDate ASC, startTime ASC, priority DESC, createdAt ASC`,
    endDate,
    startDate,
    startDate,
    endDate,
  ).map(rowToItem);

  const allConflicts = computeConflicts(db, { now, prefs });
  const dayDates = Array.from({ length: n }, (_, i) => addDays(startDate, i));

  const daysOut = dayDates.map((date) => {
    const items = [];
    const seen = new Set();
    for (const item of rows) {
      const scheduledToday =
        (item.precision === 'slot' || item.precision === 'day') && item.startDate === date;
      const dueToday = item.dueDate === date;
      const coversToday =
        item.precision !== 'slot' &&
        item.precision !== 'day' &&
        item.startDate &&
        item.startDate <= date &&
        item.endDate >= date &&
        item.startDate === date; // 只在其区间起始日列出，避免年目标天天刷屏
      if (!scheduledToday && !dueToday && !coversToday) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push({ ...item, dueToday });
    }
    const busy = busyIntervalsForDay(items);
    const loadMin = dayLoadMin(items);
    const dayConflicts = allConflicts.filter((c) => c.date === date && (c.type === 'overlap' || c.type === 'overload'));
    const dueConflicts = allConflicts.filter(
      (c) => c.type === 'due-risk' && c.date === date,
    );
    return {
      date,
      weekday: weekdayLabel(date),
      items,
      loadMin,
      freeSlots: freeSlotsForDay(busy, slotMinutes),
      conflicts: [...dayConflicts, ...dueConflicts],
    };
  });

  const totalMin = daysOut.reduce((s, d) => s + d.loadMin, 0);
  const busyDays = daysOut.filter((d) => d.loadMin > 0).length;
  const tightest = daysOut.reduce((best, d) => (d.loadMin > (best ? best.loadMin : -1) ? d : best), null);
  const candidates = unscheduledCandidates(db, { days: n, now }).map((c) => ({
    ...c.item,
    candidateReason: c.reason,
    dueInDays: c.dueInDays,
  }));

  return {
    days: daysOut,
    unscheduledCandidates: candidates,
    summary: {
      from: startDate,
      to: endDate,
      days: n,
      totalMin,
      busyDays,
      tightestDay: tightest && tightest.loadMin > 0 ? tightest.date : null,
      freeMin: daysOut.reduce((s, d) => s + d.freeSlots.reduce((a, f) => a + f.min, 0), 0),
    },
    now: nowStamp(now),
    slotMinutes,
  };
}

// ---------------------------------------------------------------------------
// 冲突
// ---------------------------------------------------------------------------

function activeItems(db) {
  return all(db, "SELECT * FROM items WHERE status != 'cancelled'").map(rowToItem);
}

function lastActivityAt(db, item) {
  const row = get(
    db,
    `SELECT MAX(at) AS at FROM history
     WHERE itemId = ? AND action IN ('progress','update','complete','create')`,
    item.id,
  );
  const hist = row && row.at ? String(row.at) : null;
  return hist && hist > item.updatedAt ? hist : item.updatedAt;
}

function hasConcreteExecution(items, rootId) {
  const byParent = new Map();
  for (const item of items) {
    if (!item.parentId) continue;
    if (!byParent.has(item.parentId)) byParent.set(item.parentId, []);
    byParent.get(item.parentId).push(item);
  }
  const stack = [rootId];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const child of byParent.get(cur) || []) {
      if (child.status === 'done' || child.status === 'cancelled') continue;
      if (child.precision === 'day' || child.precision === 'slot') return true;
      stack.push(child.id);
    }
  }
  return false;
}

/**
 * GET /conflicts：真实计算六类冲突。
 * type: overlap | due-risk | dependency | overload | stale-goal | no-execution
 */
export function computeConflicts(db, { now = new Date(), prefs = {} } = {}) {
  const items = activeItems(db);
  const byId = new Map(items.map((i) => [i.id, i]));
  const conflicts = [];
  const nowDate = today(now);
  const dueHorizon = Math.max(7, Number(prefs.fineWindowDays) || 5);

  // ---- overlap：同日 slot 任务时间重叠 ----
  const byDate = new Map();
  for (const item of items) {
    if (item.precision !== 'slot' || !item.startDate || !item.startTime || !item.endTime) continue;
    if (item.status === 'done') continue;
    if (!byDate.has(item.startDate)) byDate.set(item.startDate, []);
    byDate.get(item.startDate).push(item);
  }
  for (const [date, list] of byDate) {
    list.sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        const as = minutesOfDay(a.startTime);
        const ae = minutesOfDay(a.endTime);
        const bs = minutesOfDay(b.startTime);
        const be = minutesOfDay(b.endTime);
        const overlap = Math.min(ae, be) - Math.max(as, bs);
        if (overlap > 0) {
          const ids = [a.id, b.id].sort();
          conflicts.push(
            conflict(
              `${date}|${ids.join('|')}`,
              'overlap',
              'high',
              ids,
              `${date} 的「${a.title}」（${a.startTime}-${a.endTime}）与「${b.title}」（${b.startTime}-${b.endTime}）重叠 ${overlap} 分钟`,
              '把其中一个挪到空闲时段，或缩短时长',
              { date, minutes: overlap },
            ),
          );
        }
      }
    }
  }

  // ---- due-risk：截止在 N 天内且进度低/剩余工作量大 ----
  for (const item of items) {
    if (!item.dueDate) continue;
    if (item.status === 'done' || item.status === 'cancelled') continue;
    const left = diffDays(nowDate, item.dueDate);
    if (left < 0 || left > dueHorizon) continue;
    const total = estimateMinutes(item);
    const remaining = Math.round((total * (100 - item.progress)) / 100);
    if (!(item.progress < 60 || (left <= 2 && item.progress < 90))) continue;
    const severity = left <= 1 || item.progress < 30 ? 'high' : 'medium';
    conflicts.push(
      conflict(
        `${item.id}|${item.dueDate}`,
        'due-risk',
        severity,
        [item.id],
        `「${item.title}」${left === 0 ? '今天' : `${left} 天后`}到期（${item.dueDate}），进度 ${item.progress}%，预计还剩 ${remaining} 分钟`,
        item.progress < 30
          ? '今天先推进 30 分钟，或和用户确认是否需要顺延截止'
          : '把剩余工作拆成 1–2 个 slot 排进窗口',
        { date: item.dueDate, daysLeft: left, remainingMin: remaining },
      ),
    );
  }

  // ---- dependency：前置未完成但后继已排期/已开始 ----
  const deps = all(db, 'SELECT * FROM dependencies');
  for (const dep of deps) {
    const from = byId.get(dep.fromId);
    const to = byId.get(dep.toId);
    if (!from || !to) continue;
    const fromDone = from.status === 'done';
    const toScheduled =
      (to.precision === 'slot' || to.precision === 'day') && !!to.startDate;
    const toStarted = to.status === 'active' || to.progress > 0;
    if (fromDone || (!toScheduled && !toStarted)) continue;
    const soon = to.startDate && diffDays(nowDate, to.startDate) <= 7;
    conflicts.push(
      conflict(
        `${dep.fromId}|${dep.toId}`,
        'dependency',
        soon ? 'high' : 'medium',
        [from.id, to.id],
        `「${to.title}」依赖「${from.title}」，但前置项尚未完成（${from.status}）`,
        '先完成前置项，或取消这条依赖',
        { date: to.startDate || null },
      ),
    );
  }

  // ---- overload：单日 >6 小时 ----
  for (const [date, list] of byDate) {
    const load = dayLoadMin(list);
    if (load <= OVERLOAD_MIN) continue;
    conflicts.push(
      conflict(
        `${date}|${load}`,
        'overload',
        load > OVERLOAD_MIN + 120 ? 'high' : 'medium',
        list.map((i) => i.id).sort(),
        `${date} 安排了 ${Math.round((load / 60) * 10) / 10} 小时，超过单日 6 小时上限`,
        '把低优先级任务挪到其它天空出余量',
        { date, loadMin: load },
      ),
    );
  }

  // ---- stale-goal：长期目标 30 天无进展 ----
  for (const item of items) {
    if (item.status === 'done' || item.status === 'cancelled') continue;
    if (item.kind !== 'goal' && item.kind !== 'project') continue;
    if (!['year', 'quarter', 'month'].includes(item.precision)) continue;
    const last = lastActivityAt(db, item);
    const lastDate = last ? last.slice(0, 10) : nowDate;
    const days = diffDays(lastDate, nowDate);
    if (days < 30 || item.progress >= 100) continue;
    conflicts.push(
      conflict(
        `${item.id}|${lastDate}`,
        'stale-goal',
        'medium',
        [item.id],
        `「${item.title}」已经 ${days} 天没有进展（进度 ${item.progress}%）`,
        '拆出一个本周能做完的小任务，或确认目标是否还成立',
        { date: null, daysSince: days },
      ),
    );
  }

  // ---- no-execution：季/月级计划完全没有可执行子任务 ----
  for (const item of items) {
    if (item.status === 'done' || item.status === 'cancelled') continue;
    if (!['quarter', 'month'].includes(item.precision)) continue;
    if (hasConcreteExecution(items, item.id)) continue;
    conflicts.push(
      conflict(
        `${item.id}|no-exec`,
        'no-execution',
        'medium',
        [item.id],
        `「${item.title}」（${item.precision}）还没有任何具体任务或日程`,
        '拆出 1–3 个可排在 5 天窗口里的任务',
        { date: item.startDate },
      ),
    );
  }

  conflicts.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 9;
    const sb = SEVERITY_ORDER[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return String(a.date || '') < String(b.date || '') ? -1 : 1;
  });
  return conflicts;
}

// ---------------------------------------------------------------------------
// 时间轴
// ---------------------------------------------------------------------------

function scaleRange(scale, anchor) {
  const p = parseDate(anchor);
  switch (scale) {
    case 'year': {
      const r = { startDate: `${p.y}-01-01`, endDate: `${p.y}-12-31` };
      return r;
    }
    case 'quarter': {
      return quarterRange(p.y, quarterOf(anchor));
    }
    case 'month':
      return monthRange(p.y, p.m);
    case 'week': {
      const s = startOfWeekMonday(anchor);
      return { startDate: s, endDate: endOfWeekSunday(anchor) };
    }
    case 'day':
    default:
      return { startDate: anchor, endDate: anchor };
  }
}

export function buildTimeline(db, { from, to, scale = 'month', now = new Date() } = {}) {
  const anchor = today(now);
  const base = scaleRange(scale, anchor);
  let startDate = from && isValidDate(from) ? from : base.startDate;
  let endDate = to && isValidDate(to) ? to : base.endDate;
  if (endDate < startDate) [startDate, endDate] = [endDate, startDate];

  const rows = all(
    db,
    `SELECT * FROM items
     WHERE status != 'cancelled'
       AND (
         (startDate IS NOT NULL AND startDate <= ? AND endDate >= ?)
         OR (dueDate IS NOT NULL AND dueDate BETWEEN ? AND ?)
       )
     ORDER BY startDate ASC, priority DESC, createdAt ASC`,
    endDate,
    startDate,
    startDate,
    endDate,
  ).map(rowToItem);

  const laneEnds = [];
  const out = [];
  for (const item of rows) {
    const start = item.startDate || item.dueDate;
    const end = item.endDate || item.startDate || item.dueDate;
    let lane = laneEnds.findIndex((last) => last < start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    out.push({ item, lane, start, end, precision: item.precision });
  }

  const milestones = [];
  for (const item of rows) {
    if (item.kind === 'milestone') {
      milestones.push({
        id: item.id,
        itemId: item.id,
        title: item.title,
        date: item.startDate || item.dueDate,
        kind: 'milestone',
        status: item.status,
      });
    }
    if (item.dueDate && item.dueDate >= startDate && item.dueDate <= endDate) {
      milestones.push({
        id: `due_${item.id}`,
        itemId: item.id,
        title: `截止：${item.title}`,
        date: item.dueDate,
        kind: 'due',
        status: item.status,
      });
    }
  }
  milestones.sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));

  return {
    range: { from: startDate, to: endDate, scale },
    rows: out,
    milestones,
  };
}

// ---------------------------------------------------------------------------
// 情景推演（纯计算，不写库）
// ---------------------------------------------------------------------------

function summarizeSchedule(slots, days, startDate, prefs) {
  const dayMap = new Map();
  for (let i = 0; i < days; i += 1) dayMap.set(addDays(startDate, i), 0);
  for (const s of slots) {
    if (!dayMap.has(s.startDate)) continue;
    dayMap.set(s.startDate, dayMap.get(s.startDate) + s.minutes);
  }
  let overlapCount = 0;
  const byDate = new Map();
  for (const s of slots) {
    if (!byDate.has(s.startDate)) byDate.set(s.startDate, []);
    byDate.get(s.startDate).push(s);
  }
  for (const list of byDate.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        const as = minutesOfDay(a.startTime);
        const ae = minutesOfDay(a.endTime);
        const bs = minutesOfDay(b.startTime);
        const be = minutesOfDay(b.endTime);
        if (Math.min(ae, be) - Math.max(as, bs) > 0) overlapCount += 1;
      }
    }
  }
  const loadByDay = [...dayMap.entries()].map(([date, loadMin]) => {
    const busy = (byDate.get(date) || []).map((s) => ({ start: s.startTime, end: s.endTime }));
    return {
      date,
      loadMin,
      overload: loadMin > OVERLOAD_MIN,
      freeMin: freeSlotsForDay(busy, Number(prefs.slotMinutes) || 30).reduce((a, f) => a + f.min, 0),
    };
  });
  return {
    totalMin: loadByDay.reduce((a, d) => a + d.loadMin, 0),
    busyDays: loadByDay.filter((d) => d.loadMin > 0).length,
    loadByDay,
    overlaps: overlapCount,
    overloadDays: loadByDay.filter((d) => d.overload).length,
  };
}

function slotsFromWindow(db, windowData) {
  const slots = [];
  for (const day of windowData.days) {
    for (const item of day.items) {
      if (item.precision !== 'slot' || !item.startTime || !item.endTime) continue;
      if (item.status === 'done' || item.status === 'cancelled') continue;
      slots.push({
        id: item.id,
        title: item.title,
        startDate: item.startDate,
        startTime: item.startTime,
        endTime: item.endTime,
        minutes: estimateMinutes(item),
      });
    }
  }
  return slots;
}

/**
 * POST /ai/simulate 的确定性实现。
 * scenario 是中文描述，options 可覆盖；返回 baseline/alternative/diff/risks/affected。
 */
export function simulate(db, { scenario = '', options = {}, days = 5, from = null, prefs = {}, now = new Date() } = {}) {
  const text = String(scenario || '');
  const windowData = buildWindow(db, { days, from, prefs, now });
  const startDate = windowData.summary.from;
  const n = windowData.summary.days;
  const baseSlots = slotsFromWindow(db, windowData);
  const baseline = summarizeSchedule(baseSlots, n, startDate, prefs);

  const opts = options && typeof options === 'object' ? options : {};
  const shiftMatch = /(推迟|延后|推后|往后拖|提前|提早)\s*(\d+)\s*天/.exec(text);
  let shiftDays = Number(opts.shiftDays) || 0;
  if (shiftMatch) {
    const amount = Number(shiftMatch[2]) || 0;
    shiftDays = /提前|提早/.test(shiftMatch[1]) ? -amount : amount;
  }
  const capMatch = /(?:每天|单日)(?:最多|最多只|只|只有|能|能安排)?\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*(?:小时|h|钟头)/.exec(text);
  let dailyCapMin = opts.dailyCapMin !== undefined ? Number(opts.dailyCapMin) : null;
  if (dailyCapMin === null && capMatch) dailyCapMin = Math.round(Number(capMatch[1]) * 60);
  const cancelMatch = /(?:取消|不做|删掉|放弃|砍掉)\s*[「"“]?([^」"”，,。]{1,40})[」"”]?/.exec(text);
  let cancelItemId = opts.cancelItemId || null;
  let cancelTitle = opts.cancelTitle || (cancelMatch ? cancelMatch[1].trim() : null);
  const addMatch = /(?:增加|加上|加一个|新增|插入)\s*[「"“]?([^」"”，,。]{1,40})[」"”]?/.exec(text);
  let addTask = opts.addTask || (addMatch ? { title: addMatch[1].trim(), minutes: 60 } : null);
  const zeroDay =
    opts.zeroDay ||
    (/(生病|请假|休息一天|全天没空|出门)/.test(text) ? addDays(today(now), 1) : null);

  const affected = new Set();
  let altSlots = baseSlots.map((s) => ({ ...s }));

  if (cancelTitle && !cancelItemId) {
    const hit = altSlots.find((s) => s.title.includes(cancelTitle));
    if (hit) cancelItemId = hit.id;
  }
  if (cancelItemId) {
    const before = altSlots.length;
    altSlots = altSlots.filter((s) => s.id !== cancelItemId);
    if (altSlots.length !== before) affected.add(cancelItemId);
  }

  if (shiftDays !== 0) {
    for (const s of altSlots) {
      const next = addDays(s.startDate, shiftDays);
      if (next !== s.startDate) affected.add(s.id);
      s.startDate = next;
    }
  }

  if (zeroDay) {
    for (const s of altSlots) {
      if (s.startDate === zeroDay) {
        affected.add(s.id);
        s.startDate = addDays(zeroDay, 1);
      }
    }
  }

  if (addTask && addTask.title) {
    // 放到窗口内第一个还有余量的日子 10:00 起
    let target = null;
    for (let i = 0; i < n; i += 1) {
      const date = addDays(startDate, i);
      const load = altSlots.filter((s) => s.startDate === date).reduce((a, s) => a + s.minutes, 0);
      if (load + (addTask.minutes || 60) <= OVERLOAD_MIN) {
        target = date;
        break;
      }
    }
    if (target) {
      altSlots.push({
        id: 'new_task',
        title: addTask.title,
        startDate: target,
        startTime: '10:00',
        endTime: timeFromMinutes(10 * 60 + (addTask.minutes || 60)),
        minutes: addTask.minutes || 60,
      });
      affected.add('new_task');
    }
  }

  let overflowMin = 0;
  if (dailyCapMin && dailyCapMin > 0) {
    const byDay = new Map();
    for (const s of altSlots) {
      if (!byDay.has(s.startDate)) byDay.set(s.startDate, []);
      byDay.get(s.startDate).push(s);
    }
    for (const [date, list] of byDay) {
      let load = 0;
      for (const s of list) {
        if (load + s.minutes <= dailyCapMin) {
          load += s.minutes;
        } else {
          overflowMin += s.minutes;
          affected.add(s.id);
          s.startDate = date; // 保留原日，仅计入溢出
        }
      }
    }
  }

  const alternative = summarizeSchedule(altSlots, n, startDate, prefs);

  const diff = [];
  const altMap = new Map(alternative.loadByDay.map((d) => [d.date, d]));
  for (const d of baseline.loadByDay) {
    const a = altMap.get(d.date);
    if (!a) continue;
    if (a.loadMin !== d.loadMin) {
      diff.push({ date: d.date, beforeMin: d.loadMin, afterMin: a.loadMin, deltaMin: a.loadMin - d.loadMin });
    }
  }
  if (baseline.totalMin !== alternative.totalMin) {
    diff.push({
      type: 'total',
      beforeMin: baseline.totalMin,
      afterMin: alternative.totalMin,
      deltaMin: alternative.totalMin - baseline.totalMin,
    });
  }
  if (baseline.overlaps !== alternative.overlaps) {
    diff.push({
      type: 'overlap',
      before: baseline.overlaps,
      after: alternative.overlaps,
      delta: alternative.overlaps - baseline.overlaps,
    });
  }

  const risks = [];
  for (const d of alternative.loadByDay) {
    if (d.overload) {
      risks.push(`${d.date} 仍有 ${Math.round((d.loadMin / 60) * 10) / 10} 小时，超过单日 6 小时上限`);
    }
  }
  if (overflowMin > 0) {
    risks.push(`按每天 ${Math.round((dailyCapMin / 60) * 10) / 10} 小时的产能，窗口内还有 ${overflowMin} 分钟放不下`);
  }
  if (alternative.overlaps > baseline.overlaps) {
    risks.push(`方案会让重叠从 ${baseline.overlaps} 处增加到 ${alternative.overlaps} 处`);
  }
  if (shiftDays > 0) {
    const late = all(
      db,
      "SELECT * FROM items WHERE dueDate IS NOT NULL AND status NOT IN ('done','cancelled')",
    ).map(rowToItem);
    for (const s of altSlots) {
      const item = late.find((i) => i.id === s.id);
      if (item && item.dueDate && s.startDate > item.dueDate) {
        risks.push(`「${s.title}」推迟到 ${s.startDate}，已晚于截止 ${item.dueDate}`);
      }
    }
  }
  if (zeroDay) {
    risks.push(`${zeroDay} 整天不可用，原有安排必须挪走，可能挤占后续休息时间`);
  }
  if (risks.length === 0) {
    risks.push('按当前数据推演，没有发现新的超载或重叠风险');
  }

  return {
    scenario: text,
    baseline: {
      window: { from: startDate, to: addDays(startDate, n - 1), days: n },
      totalMin: baseline.totalMin,
      busyDays: baseline.busyDays,
      loadByDay: baseline.loadByDay,
      conflicts: {
        total: windowData.days.reduce((a, d) => a + d.conflicts.length, 0),
        overlap: baseline.overlaps,
        overloadDays: baseline.overloadDays,
        dueRisk: windowData.days.reduce(
          (a, d) => a + d.conflicts.filter((c) => c.type === 'due-risk').length,
          0,
        ),
      },
      unscheduled: windowData.unscheduledCandidates.length,
    },
    alternative: {
      window: { from: startDate, to: addDays(startDate, n - 1), days: n },
      totalMin: alternative.totalMin,
      busyDays: alternative.busyDays,
      loadByDay: alternative.loadByDay,
      conflicts: {
        overlap: alternative.overlaps,
        overloadDays: alternative.overloadDays,
      },
    },
    diff,
    risks,
    affected: [...affected],
    applied: { shiftDays, dailyCapMin, cancelItemId, cancelTitle, addTask, zeroDay },
    computedAt: nowStamp(now),
  };
}

// ---------------------------------------------------------------------------
// 待安排池的建议（/ai/plan 的确定性算法）
// ---------------------------------------------------------------------------

/**
 * 为待安排任务找可用 slot。返回 ops（update），不写库。
 * 规则：按 dueDate 近的优先、priority 高的优先；默认时长 60 分钟（slotMinutes 的 2 倍作为下限）。
 */
export function proposePlacements(db, { days = 5, from = null, prefs = {}, now = new Date() } = {}) {
  const windowData = buildWindow(db, { days, from, prefs, now });
  const slotMinutes = Math.max(15, Number(prefs.slotMinutes) || 30);
  const minMinutes = Math.max(slotMinutes, 60);
  const todayStr = today(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const free = new Map();
  for (const day of windowData.days) {
    // 今天的已过去时段不再建议（契约里的 freeSlots 本身不排除过去，规划算法要排除）
    const usable =
      day.date === todayStr
        ? day.freeSlots.filter((s) => minutesOfDay(s.start) >= nowMin)
        : day.freeSlots;
    free.set(
      day.date,
      usable.map((s) => ({ ...s })),
    );
  }

  const candidates = unscheduledCandidates(db, { days, now });
  candidates.sort((a, b) => {
    const ad = a.dueInDays === null ? 999 : a.dueInDays;
    const bd = b.dueInDays === null ? 999 : b.dueInDays;
    if (ad !== bd) return ad - bd;
    return b.item.priority - a.item.priority;
  });

  const ops = [];
  const placed = [];
  for (const cand of candidates) {
    const item = cand.item;
    if (item.precision !== 'unscheduled') continue;
    const need = Math.max(slotMinutes, estimateMinutes(item), minMinutes);
    let chosen = null;
    for (const [date, slots] of free) {
      // 找回连续的若干块拼出 need
      let acc = 0;
      let startIdx = -1;
      for (let i = 0; i < slots.length; i += 1) {
        if (acc === 0) startIdx = i;
        acc += slots[i].min;
        if (acc >= need) {
          const start = slots[startIdx].start;
          const end = timeFromMinutes(minutesOfDay(start) + need);
          chosen = { date, start, end };
          // 消耗这些块
          const consumed = slots.slice(startIdx, i + 1);
          slots.splice(startIdx, consumed.length);
          const leftover = acc - need;
          if (leftover > 0) {
            slots.splice(startIdx, 0, {
              start: end,
              end: timeFromMinutes(minutesOfDay(end) + leftover),
              min: leftover,
            });
          }
          break;
        }
        if (slots[i].end !== slots[i + 1]?.start) acc = 0;
      }
      if (chosen) break;
    }
    if (!chosen) continue;
    ops.push({
      op: 'update',
      id: item.id,
      patch: {
        precision: 'slot',
        startDate: chosen.date,
        startTime: chosen.start,
        endTime: chosen.end,
      },
    });
    placed.push({
      id: item.id,
      title: item.title,
      date: chosen.date,
      startTime: chosen.start,
      endTime: chosen.end,
      dueDate: item.dueDate,
    });
  }

  // 没有待安排任务时，建议给长期目标拆一个可执行小任务
  if (ops.length === 0) {
    const goal = get(
      db,
      `SELECT * FROM items
       WHERE kind IN ('goal','project') AND status NOT IN ('done','cancelled')
         AND precision IN ('year','quarter','month')
       ORDER BY priority DESC, startDate ASC LIMIT 1`,
    );
    const targetDay = windowData.days.find((d) => (free.get(d.date) || []).length > 0);
    if (goal && targetDay) {
      const daySlots = free.get(targetDay.date);
      const slot = daySlots.find((s) => s.min >= 60) || daySlots[0];
      if (slot) {
        const end = timeFromMinutes(minutesOfDay(slot.start) + Math.min(60, slot.min));
        ops.push({
          op: 'create',
          item: {
            kind: 'task',
            title: `推进「${goal.title}」：先做 1 小时`,
            precision: 'slot',
            startDate: targetDay.date,
            startTime: slot.start,
            endTime: end,
            parentId: goal.id,
            priority: 2,
            source: 'ai',
            notes: '由本地规划算法基于真实空闲时段生成',
          },
        });
        placed.push({
          id: null,
          title: `推进「${goal.title}」：先做 1 小时`,
          date: targetDay.date,
          startTime: slot.start,
          endTime: end,
          created: true,
        });
      }
    }
  }

  return { ops, placed, window: windowData.summary, candidates: candidates.length };
}
