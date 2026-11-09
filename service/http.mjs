// HTTP 层：127.0.0.1 上的 JSON API，除 /health 外全部 Bearer 鉴权。
import http from 'node:http';
import crypto from 'node:crypto';
import {
  acceptProposal,
  addDependency,
  countItems,
  createItem,
  createProposal,
  deleteDependency,
  deleteItem,
  exportAll,
  getItemDetail,
  getTree,
  importAll,
  listDependencies,
  listItems,
  listProposals,
  patchSettings,
  rejectProposal,
  setLock,
  setProgress,
  settings as readSettings,
  updateItem,
} from './model.mjs';
import { all, dbFileSize, readPrefs, run, writePref } from './db.mjs';
import {
  buildTimeline,
  buildWindow,
  computeConflicts,
} from './planner.mjs';
import {
  ackReminder,
  cancelBootReminders,
  countReminders,
  createManualReminder,
  dndState,
  ensureBootReminder,
  listDue,
  listReminders,
  syncItemReminders,
  waterAck,
} from './reminders.mjs';
import { ApiError, badRequest, isApiError, notFound, unauthorized } from './errors.mjs';
import {
  addDays,
  addMinutesToStamp,
  diffDays,
  isValidTime,
  nowStamp,
  today,
  TZ,
} from './time.mjs';

const MAX_BODY = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------

function compilePattern(pattern) {
  return pattern.split('/').filter(Boolean);
}

function matchPattern(segments, parts) {
  if (segments.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
    else if (seg !== parts[i]) return null;
  }
  return params;
}

export function createApp(ctx) {
  const { db, ai, log, version, dbPath, startedAt, token, scheduler } = ctx;
  const routes = [];

  const route = (method, pattern, handler) => {
    routes.push({ method, segments: compilePattern(pattern), handler, pattern });
  };

  // ---- 基础 ----
  route('GET', '/health', () => ({
    ok: true,
    version,
    dbPath,
    ai: ai.mode === 'api' ? 'api' : 'off',
    now: nowStamp(),
    tz: TZ,
    uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
  }));

  route('GET', '/state', () => {
    const prefs = readPrefs(db);
    const dnd = dndState(db, prefs);
    const boot = all(db, 'SELECT * FROM bootEvents ORDER BY at DESC, rowid DESC LIMIT 1')[0] || null;
    return {
      now: nowStamp(),
      tz: TZ,
      focus: prefs.focus || { active: false, startedAt: null, plannedEndAt: null, note: '' },
      dnd,
      ai: { mode: ai.mode, model: ai.mode === 'api' ? ai.status().model : null },
      boot: boot
        ? { id: boot.id, at: boot.at, greeted: Number(boot.greeted) ? 1 : 0 }
        : { id: null, at: null, greeted: 0 },
      scheduler: scheduler ? { ...scheduler.state } : null,
    };
  });

  route('GET', '/stats', () => ({
    items: countItems(db),
    reminders: countReminders(db),
    dbBytes: dbFileSize(dbPath),
    rssBytes: process.memoryUsage().rss,
  }));

  route('GET', '/export', () => exportAll(db, { version }));
  route('POST', '/import', (req, params, body) => importAll(db, body, { mode: body.mode || 'replace' }));

  // ---- 计划项 ----
  route('GET', '/items', (req) => listItems(db, req.query));

  route('GET', '/items/:id', (req, params) => getItemDetail(db, params.id));

  route('POST', '/items', (req, params, body) => {
    const source = body.source === 'ai' ? 'ai' : 'user';
    const item = createItem(db, body, { source, actorSource: source });
    syncItemReminders(db, item, { prefs: readPrefs(db) });
    return item;
  });

  route('PATCH', '/items/:id', (req, params, body) => {
    const source = normalizeSource(body.source || req.headers['x-source']);
    const item = updateItem(db, params.id, body, { source, actorSource: source });
    syncItemReminders(db, item, { prefs: readPrefs(db) });
    return item;
  });

  route('DELETE', '/items/:id', (req, params) => deleteItem(db, params.id));

  route('POST', '/items/:id/progress', (req, params, body) => {
    const source = normalizeSource(body.source || req.headers['x-source']);
    const item = setProgress(db, params.id, body, { source });
    syncItemReminders(db, item, { prefs: readPrefs(db) });
    return item;
  });

  route('POST', '/items/:id/lock', (req, params, body) => {
    if (body.locked === undefined) throw badRequest('locked is required');
    return setLock(db, params.id, body.locked);
  });

  route('GET', '/tree', () => getTree(db));

  // ---- 时间窗口 / 冲突 / 时间轴 ----
  route('GET', '/window', (req) => {
    const prefs = readPrefs(db);
    const days = Number(req.query.days) || Number(prefs.fineWindowDays) || 5;
    return buildWindow(db, { days, from: req.query.from || null, prefs });
  });

  route('GET', '/conflicts', () => ({ conflicts: computeConflicts(db, { prefs: readPrefs(db) }) }));

  route('GET', '/timeline', (req) =>
    buildTimeline(db, {
      from: req.query.from || null,
      to: req.query.to || null,
      scale: req.query.scale || 'month',
    }),
  );

  // ---- AI ----
  route('POST', '/ai/parse', async (req, params, body) => {
    if (typeof body.text !== 'string' || !body.text.trim()) throw badRequest('text is required');
    return ai.parse(body.text);
  });

  route('POST', '/ai/create-from-text', async (req, params, body) => {
    if (typeof body.text !== 'string' || !body.text.trim()) throw badRequest('text is required');
    return ai.createFromText(body.text, { confirm: body.confirm !== false });
  });

  route('POST', '/ai/plan', async (req, params, body) => {
    const result = await ai.plan({ days: body.days, from: body.from || null });
    // 契约 §2.4：/ai/plan 返回新建的 proposal 本身
    return { ...result.proposal, mode: result.mode, model: result.model };
  });

  route('POST', '/ai/analyze', async (req, params, body) => {
    const scope = ['5d', '30d', 'all'].includes(body.scope) ? body.scope : '5d';
    return ai.analyze({ scope });
  });

  route('POST', '/ai/simulate', async (req, params, body) => {
    const scenario = typeof body.scenario === 'string' ? body.scenario : '';
    if (!scenario.trim() && !body.options) throw badRequest('scenario or options is required');
    return ai.simulate({
      scenario,
      options: body.options || {},
      days: body.days,
      from: body.from || null,
    });
  });

  route('POST', '/ai/chat', async (req, params, body) => {
    if (typeof body.text !== 'string' || !body.text.trim()) throw badRequest('text is required');
    return ai.chat({ text: body.text, context: body.context || null });
  });

  // ---- proposals ----
  route('GET', '/proposals', (req) => listProposals(db, { status: req.query.status || null }));

  route('POST', '/proposals', (req, params, body) => createProposal(db, body, { source: 'user' }));

  route('POST', '/proposals/:id/accept', (req, params) => acceptProposal(db, params.id, { source: 'ai' }));

  route('POST', '/proposals/:id/reject', (req, params) => rejectProposal(db, params.id));

  // ---- reminders ----
  route('GET', '/reminders/due', () => listDue(db));

  route('POST', '/reminders/:id/ack', (req, params, body) =>
    ackReminder(db, params.id, { action: body.action, snoozeMin: body.snoozeMin }),
  );

  route('GET', '/reminders', (req) =>
    listReminders(db, {
      status: req.query.status || null,
      kind: req.query.kind || null,
      itemId: req.query.itemId || null,
      limit: req.query.limit,
    }),
  );

  route('POST', '/reminders', (req, params, body) => createManualReminder(db, body));

  route('POST', '/water/ack', () => waterAck(db));

  // ---- 依赖（契约 §1.2 有表但 §2 未列接口，作为实现扩展补充，见 docs/API.md 备注） ----
  route('GET', '/dependencies', (req) => ({
    dependencies: listDependencies(db, { itemId: req.query.itemId || null }),
  }));
  route('POST', '/dependencies', (req, params, body) => addDependency(db, body));
  route('DELETE', '/dependencies/:id', (req, params) => deleteDependency(db, params.id));

  // ---- 开机邀请 ----
  route('POST', '/boot/hello', (req, params, body) => {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) throw badRequest('sessionId is required');
    if (sessionId.length > 200) throw badRequest('sessionId too long');
    const kind = ['login', 'resume', 'restart'].includes(body.kind) ? body.kind : 'login';
    const prefs = readPrefs(db);
    const existing = all(db, 'SELECT * FROM bootEvents WHERE sessionId = ?', sessionId)[0] || null;

    const windowData = buildWindow(db, { days: 5, prefs });
    const seen = new Set();
    let planned = 0;
    let firstTask = null;
    for (const day of windowData.days) {
      for (const item of day.items) {
        if (seen.has(item.id) || item.status === 'done' || item.status === 'cancelled') continue;
        seen.add(item.id);
        planned += 1;
        if (!firstTask) {
          firstTask = {
            id: item.id,
            title: item.title,
            date: item.startDate,
            startTime: item.startTime,
            endTime: item.endTime,
          };
        }
      }
    }
    const conflicts = computeConflicts(db, { prefs });
    const unscheduled = windowData.unscheduledCandidates.length;
    const horizon = addDays(today(), 7);
    const dueRows = all(
      db,
      `SELECT * FROM items
       WHERE dueDate IS NOT NULL AND dueDate >= ? AND dueDate <= ?
         AND status NOT IN ('done','cancelled')
       ORDER BY dueDate ASC LIMIT 5`,
      today(),
      horizon,
    );
    const summary = {
      days: 5,
      planned,
      unscheduled,
      dueSoon: dueRows.map((r) => ({
        id: r.id,
        title: r.title,
        dueDate: r.dueDate,
        dueInDays: diffDays(today(), r.dueDate),
      })),
      conflicts: conflicts.length,
      firstTask,
    };

    const shouldGreet = !existing && prefs.bootGreeting !== false;
    if (!existing) {
      run(
        db,
        `INSERT INTO bootEvents(id, sessionId, kind, at, greeted, snoozeUntil, action)
         VALUES (?,?,?,?,?,?,?)`,
        `b_${crypto.randomBytes(6).toString('hex')}`,
        sessionId,
        kind,
        nowStamp(),
        shouldGreet ? 1 : 0,
        null,
        null,
      );
    } else {
      run(db, 'UPDATE bootEvents SET kind = ?, at = ? WHERE sessionId = ?', kind, nowStamp(), sessionId);
    }

    return {
      shouldGreet,
      sessionId,
      kind,
      greeting: buildGreeting({ planned, unscheduled, conflicts: conflicts.length, firstTask }),
      summary,
      actions: ['plan', 'view', 'later'],
    };
  });

  route('POST', '/boot/ack', (req, params, body) => {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) throw badRequest('sessionId is required');
    const action = body.action;
    if (!['plan', 'view', 'later'].includes(action)) {
      throw badRequest('action must be plan|view|later');
    }
    const prefs = readPrefs(db);
    const minutes =
      Number.isFinite(Number(body.snoozeMin)) && Number(body.snoozeMin) > 0
        ? Number(body.snoozeMin)
        : Number(prefs.bootSnoozeMin) || 30;
    const event = all(db, 'SELECT * FROM bootEvents WHERE sessionId = ?', sessionId)[0];
    if (!event) throw notFound('unknown sessionId', 'BOOT_SESSION_NOT_FOUND');

    let reminder = null;
    if (action === 'later') {
      const fireAt = addMinutesToStamp(nowStamp(), minutes);
      reminder = ensureBootReminder(db, {
        sessionId,
        fireAt,
        title: '继续规划今天',
        body: `${minutes} 分钟后提醒你回来看计划。`,
        dedupeKey: `boot:${sessionId}:later`,
      });
      run(
        db,
        'UPDATE bootEvents SET action = ?, snoozeUntil = ? WHERE sessionId = ?',
        action,
        fireAt,
        sessionId,
      );
    } else {
      cancelBootReminders(db, sessionId);
      run(db, 'UPDATE bootEvents SET action = ?, snoozeUntil = NULL WHERE sessionId = ?', action, sessionId);
      if (action === 'plan') {
        ensureBootReminder(db, {
          sessionId,
          fireAt: nowStamp(),
          title: '开始规划',
          body: '打开规划中心，先把待安排的任务排进空档。',
          dedupeKey: `boot:${sessionId}:plan`,
        });
      }
    }
    return {
      ok: true,
      sessionId,
      action,
      snoozeMin: action === 'later' ? minutes : null,
      reminder,
      boot: all(db, 'SELECT * FROM bootEvents WHERE sessionId = ?', sessionId)[0] || null,
    };
  });

  // ---- 设置 ----
  route('GET', '/settings', () => readSettings(db));
  route('PATCH', '/settings', (req, params, body) => patchSettings(db, body));

  // ---- 专注 / 免打扰 ----
  route('POST', '/focus', (req, params, body) => {
    const prefs = readPrefs(db);
    const prev = prefs.focus || {};
    if (body.active === true) {
      const minutes = Math.max(1, Math.min(480, Number(body.minutes) || 45));
      const startedAt = nowStamp();
      const focus = {
        active: true,
        startedAt,
        plannedEndAt: addMinutesToStamp(startedAt, minutes),
        note: typeof body.note === 'string' ? body.note.slice(0, 500) : prev.note || '',
        minutes,
      };
      writePref(db, 'focus', focus);
      return focus;
    }
    if (body.active === false) {
      const focus = {
        active: false,
        startedAt: prev.startedAt || null,
        plannedEndAt: prev.plannedEndAt || null,
        endedAt: nowStamp(),
        note: typeof body.note === 'string' ? body.note.slice(0, 500) : prev.note || '',
      };
      writePref(db, 'focus', focus);
      return focus;
    }
    throw badRequest('active must be true or false');
  });

  route('POST', '/dnd', (req, params, body) => {
    if (typeof body.active !== 'boolean') throw badRequest('active must be a boolean');
    const prefs = readPrefs(db);
    const prev = prefs.dnd || {};
    let until = null;
    if (body.active) {
      if (body.until !== undefined && body.until !== null) {
        if (!isValidTime(body.until)) throw badRequest('until must be HH:mm or null');
        until = body.until;
      }
    }
    const dnd = { ...prev, active: body.active, until: body.active ? until : null };
    writePref(db, 'dnd', dnd);
    return dndState(db, readPrefs(db));
  });

  // -------------------------------------------------------------------------
  // 请求处理
  // -------------------------------------------------------------------------

  function isAuthorized(req) {
    const header = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return false;
    const given = Buffer.from(m[1].trim());
    const expected = Buffer.from(token);
    if (given.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(given, expected);
    } catch {
      return false;
    }
  }

  async function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(badRequest('request body too large', 'BODY_TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve({});
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) return resolve({});
        try {
          const parsed = JSON.parse(raw);
          if (parsed === null || typeof parsed !== 'object') {
            reject(badRequest('body must be a JSON object', 'INVALID_JSON'));
            return;
          }
          resolve(parsed);
        } catch {
          reject(badRequest('invalid JSON body', 'INVALID_JSON'));
        }
      });
      req.on('error', (err) => reject(err));
    });
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }

  async function handler(req, res) {
    const started = Date.now();
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    let matched = null;
    let params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const p = matchPattern(r.segments, parts);
      if (p) {
        matched = r;
        params = p;
        break;
      }
    }

    try {
      if (!matched) {
        // 路径存在但方法不对时给 405，否则 404
        const otherMethod = routes.some((r) => matchPattern(r.segments, parts));
        if (otherMethod) throw new ApiError(405, 'method not allowed', 'METHOD_NOT_ALLOWED');
        throw notFound('not found', 'NOT_FOUND');
      }
      if (matched.pattern !== '/health' && !isAuthorized(req)) {
        throw unauthorized();
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const result = await matched.handler({ query, method: req.method, headers: req.headers, path: url.pathname }, params, body);
      sendJson(res, 200, result === undefined ? { ok: true } : result);
      log('debug', `${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    } catch (err) {
      if (isApiError(err)) {
        const payload = { error: err.message };
        if (err.code) payload.code = err.code;
        sendJson(res, err.status, payload);
        log('warn', `${req.method} ${url.pathname} -> ${err.status} ${err.message}`);
        return;
      }
      log('error', `${req.method} ${url.pathname} failed: ${err && err.stack ? err.stack : err}`);
      sendJson(res, 500, { error: 'internal error', code: 'INTERNAL' });
    }
  }

  return {
    handler,
    routes,
    isAuthorized,
    readBody,
    sendJson,
  };
}

function normalizeSource(raw) {
  if (raw === 'ai') return 'ai';
  if (raw === 'import') return 'import';
  return 'user';
}

function buildGreeting({ planned, unscheduled, conflicts, firstTask }) {
  const hour = new Date().getHours();
  const hello = hour < 6 ? '还没睡？' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  if (conflicts > 0) {
    return `${hello}，今天有 ${conflicts} 处安排冲突，先看一眼再开工吧。`;
  }
  if (firstTask) {
    const when = firstTask.startTime ? `${firstTask.startTime} ` : '';
    return `${hello}，接下来 5 天有 ${planned} 项安排，${when}先做「${firstTask.title}」。${unscheduled > 0 ? `还有 ${unscheduled} 项待安排。` : ''}`;
  }
  if (unscheduled > 0) {
    return `${hello}，还没有具体日程，待安排池里有 ${unscheduled} 项，要不要现在排一下？`;
  }
  return `${hello}，今天还没有安排。想先规划点什么？`;
}

/** 供 index.mjs 创建 node:http server */
export function createHttpServer(ctx) {
  const app = createApp(ctx);
  const server = http.createServer((req, res) => {
    app.handler(req, res).catch((err) => {
      try {
        ctx.log('error', `unhandled http error: ${err && err.stack ? err.stack : err}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ error: 'internal error', code: 'INTERNAL' }));
      } catch {
        /* 连接可能已断开 */
      }
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 35000;
  server.keepAliveTimeout = 5000;
  return { server, app };
}
