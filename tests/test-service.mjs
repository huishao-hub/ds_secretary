// 端到端测试：真实起服务、真实 HTTP、真实 SQLite。
// 运行：node tests/test-service.mjs
// 退出码 0 = 全部 PASS，非 0 = 有 FAIL。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createService } from '../service/index.mjs';
import { writePref } from '../service/db.mjs';

// ---------------------------------------------------------------------------
// 迷你测试框架
// ---------------------------------------------------------------------------

const results = [];
let passed = 0;
let failed = 0;

async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    passed += 1;
    results.push({ name, ok: true, ms: Date.now() - start });
    console.log(`PASS  ${name}  (${Date.now() - start}ms)`);
  } catch (err) {
    failed += 1;
    results.push({ name, ok: false, ms: Date.now() - start, error: err });
    console.log(`FAIL  ${name}  (${Date.now() - start}ms)`);
    const detail = err && err.stack ? err.stack : String(err);
    console.log(
      detail
        .split('\n')
        .slice(0, 6)
        .map((l) => `      ${l}`)
        .join('\n'),
    );
  }
}

function expectStatus(res, status, label = '') {
  if (res.status !== status) {
    throw new Error(
      `${label || 'request'} expected HTTP ${status}, got ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`,
    );
  }
  return res.body;
}

// ---------------------------------------------------------------------------
// 环境与客户端
// ---------------------------------------------------------------------------

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-secretary-test-'));
let svc = null;
let token = null;
let api = null;

function makeApi(port, authToken) {
  return async function request(method, urlPath, body, opts = {}) {
    const headers = {};
    const usedToken = opts.token !== undefined ? opts.token : authToken;
    if (opts.auth !== false) headers.Authorization = `Bearer ${usedToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed };
  };
}

const request = (...args) => api(...args);

async function startService(extra = {}) {
  svc = await createService({
    dataDir,
    port: 0,
    aiKey: null,
    tickMs: 60000,
    verbose: false,
    ...extra,
  });
  token = svc.token;
  api = makeApi(svc.port, token);
  return svc;
}

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function stampToDate(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(String(stamp));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

// 共享的测试数据
const tomorrow = addDaysStr(todayStr(), 1);
let yearGoal = null;
let quarterPlan = null;
let slotTask = null;
let startReminder = null;
let endReminder = null;
let overlapTask = null;
let lockedItem = null;

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

try {
  await startService();
} catch (err) {
  console.error('FATAL: failed to start service:', err && err.stack ? err.stack : err);
  process.exit(1);
}

await test('01 year goal materializes full-year interval (not a single day)', async () => {
  const item = expectStatus(
    await request('POST', '/items', {
      kind: 'goal',
      title: '2027 全年系统研究 AI',
      precision: 'year',
      startDate: '2027-01-01',
      priority: 3,
      source: 'user',
    }),
    200,
    'create year goal',
  );
  assert.equal(item.precision, 'year');
  assert.equal(item.startDate, '2027-01-01');
  assert.equal(item.endDate, '2027-12-31');
  assert.equal(item.startTime, null);
  assert.equal(item.endTime, null);
  assert.equal(item.kind, 'goal');
  assert.match(item.id, /^g_[0-9a-f]{12}$/);
  const spanDays = (new Date(`${item.endDate}T00:00:00`) - new Date(`${item.startDate}T00:00:00`)) / 86400000;
  assert.ok(spanDays > 360, `year interval should span a year, got ${spanDays} days`);

  // 传入年中的日期也必须被展开成整年区间，而不是停在 7 月 3 日
  const snapped = expectStatus(
    await request('POST', '/items', {
      kind: 'goal',
      title: '2028 读 20 本书',
      precision: 'year',
      startDate: '2028-07-03',
    }),
    200,
    'create snapped year goal',
  );
  assert.equal(snapped.startDate, '2028-01-01');
  assert.equal(snapped.endDate, '2028-12-31');
  yearGoal = item;
});

await test('02 quarter plan materializes quarter interval', async () => {
  const item = expectStatus(
    await request('POST', '/items', {
      kind: 'project',
      title: '2027 Q2 产品原型',
      precision: 'quarter',
      startDate: '2027-05-20',
    }),
    200,
    'create quarter plan',
  );
  assert.equal(item.precision, 'quarter');
  assert.equal(item.startDate, '2027-04-01');
  assert.equal(item.endDate, '2027-06-30');
  assert.equal(item.fuzzyLabel, '2027 Q2');
  assert.equal(item.startTime, null);
  quarterPlan = item;
});

await test('03 slot task creates start/end reminders with exact dedupeKey', async () => {
  const item = expectStatus(
    await request('POST', '/items', {
      kind: 'task',
      title: '写项目方案',
      precision: 'slot',
      startDate: tomorrow,
      startTime: '14:00',
      endTime: '16:00',
    }),
    200,
    'create slot task',
  );
  assert.equal(item.precision, 'slot');
  assert.equal(item.startDate, tomorrow);
  assert.equal(item.endDate, tomorrow);
  assert.equal(item.startTime, '14:00');
  assert.equal(item.endTime, '16:00');
  slotTask = item;

  const detail = expectStatus(await request('GET', `/items/${item.id}`), 200, 'get item detail');
  assert.ok(Array.isArray(detail.reminders), 'detail.reminders must be an array');
  startReminder = detail.reminders.find((r) => r.kind === 'start');
  endReminder = detail.reminders.find((r) => r.kind === 'end');
  assert.ok(startReminder, 'start reminder missing');
  assert.ok(endReminder, 'end reminder missing');
  assert.equal(startReminder.dedupeKey, `item:${item.id}:start:${tomorrow}`);
  assert.equal(endReminder.dedupeKey, `item:${item.id}:end:${tomorrow}`);
  assert.equal(startReminder.fireAt, `${tomorrow}T14:00:00`);
  assert.equal(endReminder.fireAt, `${tomorrow}T16:00:00`);
  assert.equal(startReminder.status, 'pending');

  // 幂等：再次 PATCH 同一时间不会新增提醒
  expectStatus(await request('PATCH', `/items/${item.id}`, { notes: '补充说明' }), 200, 'patch notes');
  const detail2 = expectStatus(await request('GET', `/items/${item.id}`), 200, 'get item detail 2');
  const starts = detail2.reminders.filter((r) => r.kind === 'start');
  assert.equal(starts.length, 1, `expected 1 start reminder, got ${starts.length}`);
});

await test('04 overlapping slots are reported by /window as overlap', async () => {
  overlapTask = expectStatus(
    await request('POST', '/items', {
      kind: 'task',
      title: '评审需求',
      precision: 'slot',
      startDate: tomorrow,
      startTime: '15:00',
      endTime: '17:00',
    }),
    200,
    'create overlapping task',
  );
  const win = expectStatus(await request('GET', `/window?days=1&from=${tomorrow}`), 200, 'window');
  assert.equal(win.days.length, 1);
  const day = win.days[0];
  assert.equal(day.date, tomorrow);
  assert.ok(day.items.length >= 2, `expected >=2 items, got ${day.items.length}`);
  const overlap = day.conflicts.filter((c) => c.type === 'overlap');
  assert.ok(overlap.length >= 1, `expected overlap conflict, got ${JSON.stringify(day.conflicts)}`);
  assert.ok(overlap[0].itemIds.includes(slotTask.id));
  assert.ok(overlap[0].itemIds.includes(overlapTask.id));
  assert.ok(day.loadMin >= 240, `expected loadMin >= 240, got ${day.loadMin}`);
  assert.ok(day.freeSlots.length > 0, 'free slots should not be empty');
  assert.ok(day.freeSlots.every((s) => s.start >= '08:00'), 'free slots must exclude 00:00-08:00');
  assert.ok(
    day.freeSlots.some((s) => s.start === '08:00'),
    '08:00-08:30 should be free',
  );
  // 14:00-17:00 已被占用，不能出现在空闲块里
  assert.ok(!day.freeSlots.some((s) => s.start >= '14:00' && s.start < '17:00'));
  assert.ok(win.summary.totalMin >= 240);
});

await test('05 locked item rejects ai update with 409, allows user update', async () => {
  lockedItem = expectStatus(
    await request('POST', '/items', {
      kind: 'task',
      title: '锁定项',
      precision: 'day',
      startDate: tomorrow,
      locked: 1,
    }),
    200,
    'create locked item',
  );
  assert.equal(lockedItem.locked, 1);

  const aiPatch = await request('PATCH', `/items/${lockedItem.id}`, { title: 'AI 改名', source: 'ai' });
  assert.equal(aiPatch.status, 409, `expected 409, got ${aiPatch.status}`);
  assert.equal(aiPatch.body.error, 'locked');
  assert.equal(aiPatch.body.code, 'LOCKED');

  const userPatch = await request('PATCH', `/items/${lockedItem.id}`, { title: '用户改名', source: 'user' });
  expectStatus(userPatch, 200, 'user patch');
  assert.equal(userPatch.body.title, '用户改名');

  // 不带 source 的请求默认按 user 处理，locked 项允许修改
  const userDefaultPatch = await request('PATCH', `/items/${lockedItem.id}`, { title: '默认用户改名' });
  expectStatus(userDefaultPatch, 200, 'default user patch');
});

await test('06 proposal accept skips locked item and reports it', async () => {
  const proposal = expectStatus(
    await request('POST', '/proposals', {
      kind: 'manual',
      title: '测试提案',
      summary: '一条改锁定项，一条新建',
      ops: [
        { op: 'update', id: lockedItem.id, patch: { title: '提案改名' } },
        {
          op: 'create',
          item: {
            kind: 'task',
            title: '提案生成任务',
            precision: 'day',
            startDate: tomorrow,
            source: 'ai',
          },
        },
      ],
    }),
    200,
    'create proposal',
  );
  assert.equal(proposal.status, 'draft');

  const accepted = expectStatus(await request('POST', `/proposals/${proposal.id}/accept`), 200, 'accept');
  assert.equal(accepted.skipped.length, 1);
  assert.equal(accepted.skipped[0].id, lockedItem.id);
  assert.equal(accepted.skipped[0].reason, 'locked');
  assert.equal(accepted.applied.length, 1);
  assert.equal(accepted.applied[0].op, 'create');
  assert.equal(accepted.proposal.status, 'accepted');

  const after = expectStatus(await request('GET', `/items/${lockedItem.id}`), 200, 'locked after accept');
  assert.equal(after.title, '默认用户改名', 'locked item must be untouched by proposal');
});

await test('07 done item cancels its pending start reminder', async () => {
  const done = expectStatus(
    await request('POST', `/items/${slotTask.id}/progress`, { status: 'done', progress: 100 }),
    200,
    'mark done',
  );
  assert.equal(done.status, 'done');
  assert.equal(done.progress, 100);
  assert.ok(done.completedAt, 'completedAt must be set');

  const detail = expectStatus(await request('GET', `/items/${slotTask.id}`), 200, 'detail after done');
  const start = detail.reminders.find((r) => r.id === startReminder.id);
  assert.ok(start, 'original start reminder should still exist for audit');
  assert.equal(start.status, 'cancelled');

  const pending = expectStatus(
    await request('GET', `/reminders?status=pending&itemId=${slotTask.id}`),
    200,
    'pending reminders for done item',
  );
  assert.equal(pending.length, 0, `expected no pending reminders, got ${pending.length}`);
});

await test('08 restart: data persists, bridge rebuilt, no duplicate reminders', async () => {
  const before = expectStatus(await request('GET', '/items?limit=2000'), 200, 'items before');
  const beforeReminders = expectStatus(await request('GET', '/reminders?limit=1000'), 200, 'reminders before');
  const beforeKeys = beforeReminders.map((r) => r.dedupeKey).sort();
  const oldToken = token;
  const oldPort = svc.port;

  await svc.close();
  assert.equal(fs.existsSync(path.join(dataDir, 'bridge.json')), false, 'bridge.json must be removed on close');
  assert.equal(oldPort > 0, true);

  await startService();
  const bridgePath = path.join(dataDir, 'bridge.json');
  assert.equal(fs.existsSync(bridgePath), true, 'bridge.json must be recreated');
  const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
  assert.equal(bridge.port, svc.port);
  assert.equal(bridge.token, svc.token);
  assert.notEqual(bridge.token, oldToken, 'token must rotate on restart');
  assert.equal(bridge.pid, process.pid);
  assert.equal(bridge.version, '1.0.0');
  assert.match(bridge.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

  const unauthorizedOld = await request('GET', '/items', undefined, { token: oldToken });
  assert.equal(unauthorizedOld.status, 401, 'old token must be rejected');

  const after = expectStatus(await request('GET', '/items?limit=2000'), 200, 'items after');
  assert.equal(after.total, before.total, 'item count must survive restart');

  const afterReminders = expectStatus(await request('GET', '/reminders?limit=1000'), 200, 'reminders after');
  const afterKeys = afterReminders.map((r) => r.dedupeKey);
  assert.equal(new Set(afterKeys).size, afterKeys.length, 'dedupeKey must stay unique');
  assert.deepEqual(afterKeys.sort(), beforeKeys, 'restart must not duplicate or drop reminders');

  const due = expectStatus(await request('GET', '/reminders/due'), 200, 'due after restart');
  assert.equal(due.items.length, 0, 'nothing should be due yet');
});

await test('09 snooze 30 minutes creates a new reminder with repeatOf', async () => {
  const item = expectStatus(
    await request('POST', '/items', {
      kind: 'task',
      title: '晚间复盘',
      precision: 'slot',
      startDate: tomorrow,
      startTime: '18:00',
      endTime: '19:00',
    }),
    200,
    'create snooze task',
  );
  const detail = expectStatus(await request('GET', `/items/${item.id}`), 200, 'detail');
  const start = detail.reminders.find((r) => r.kind === 'start');
  assert.ok(start, 'start reminder missing');

  const before = new Date();
  const res = expectStatus(
    await request('POST', `/reminders/${start.id}/ack`, { action: 'snooze', snoozeMin: 30 }),
    200,
    'snooze',
  );
  const after = new Date();
  assert.equal(res.ok, true);
  assert.equal(res.repeatOf, start.id);
  assert.equal(res.reminder.repeatOf, start.id);
  assert.equal(res.reminder.status, 'pending');
  assert.equal(res.reminder.snoozedTo, res.snoozedTo);
  assert.equal(res.reminder.fireAt, res.snoozedTo);

  const fire = stampToDate(res.snoozedTo);
  assert.ok(fire, `invalid snoozedTo ${res.snoozedTo}`);
  const expectedMin = (fire - before) / 60000;
  assert.ok(expectedMin >= 29 && expectedMin <= 31.5, `expected ~30 min, got ${expectedMin}`);

  const orig = expectStatus(await request('GET', `/reminders?status=snoozed&limit=200`), 200, 'snoozed list');
  const origRow = orig.find((r) => r.id === start.id);
  assert.ok(origRow, 'original reminder must be marked snoozed');
  assert.equal(origRow.snoozedTo, res.snoozedTo);
  assert.ok(after >= before);
});

await test('10 /ai/parse "2027年我想系统地研究AI" yields year, no exact time', async () => {
  const before = expectStatus(await request('GET', '/items?limit=2000'), 200, 'items before parse');
  const res = expectStatus(
    await request('POST', '/ai/parse', { text: '2027年我想系统地研究AI' }),
    200,
    'ai parse year',
  );
  assert.equal(res.mode, 'fallback');
  assert.equal(res.intent, 'create');
  assert.ok(Array.isArray(res.ops) && res.ops.length === 1);
  const item = res.ops[0].item;
  assert.equal(item.precision, 'year');
  assert.equal(item.startDate, '2027-01-01');
  assert.equal(item.endDate, '2027-12-31');
  assert.equal(item.startTime, null);
  assert.equal(item.endTime, null);
  assert.ok(res.confidence > 0.6, `confidence too low: ${res.confidence}`);
  const after = expectStatus(await request('GET', '/items?limit=2000'), 200, 'items after parse');
  assert.equal(after.total, before.total, '/ai/parse must not write');

  // 只说了"两点到四点"：必须反问上午还是下午，绝不能猜
  const ambiguous = expectStatus(
    await request('POST', '/ai/parse', { text: '两点到四点写东西' }),
    200,
    'ai parse ambiguous',
  );
  assert.ok(ambiguous.questions.length >= 1, 'ambiguous time must produce questions');
  assert.notEqual(ambiguous.ops[0].item.precision, 'slot', 'ambiguous time must not become a slot');
  assert.equal(ambiguous.ops[0].item.startTime, null);
  assert.ok(ambiguous.confidence < 0.5);
});

await test('11 /ai/parse "明天下午两点到四点..." yields slot 14:00-16:00', async () => {
  const res = expectStatus(
    await request('POST', '/ai/parse', { text: '明天下午两点到四点写项目方案' }),
    200,
    'ai parse slot',
  );
  assert.equal(res.ops.length, 1);
  const item = res.ops[0].item;
  assert.equal(item.precision, 'slot');
  assert.equal(item.startDate, tomorrow);
  assert.equal(item.endDate, tomorrow);
  assert.equal(item.startTime, '14:00');
  assert.equal(item.endTime, '16:00');
  assert.equal(res.questions.length, 0, `unexpected questions: ${JSON.stringify(res.questions)}`);
});

await test('12 /ai/plan returns a draft proposal and does not write items', async () => {
  const before = expectStatus(await request('GET', '/items?limit=2000'), 200, 'items before plan');
  const res = expectStatus(await request('POST', '/ai/plan', { days: 5 }), 200, 'ai plan');
  assert.ok(res.id, 'proposal id missing');
  assert.match(res.id, /^pr_/);
  assert.equal(res.status, 'draft');
  assert.ok(Array.isArray(res.ops));
  assert.equal(res.kind, 'plan');
  assert.ok(typeof res.summary === 'string' && res.summary.length > 0);
  const after = expectStatus(await request('GET', '/items?limit=2000'), 200, 'items after plan');
  assert.equal(after.total, before.total, 'ai/plan must not create items directly');

  const drafts = expectStatus(await request('GET', '/proposals?status=draft'), 200, 'drafts');
  assert.ok(drafts.some((p) => p.id === res.id), 'proposal should be listed as draft');
});

await test('13 dependency cycle and self-loop are rejected', async () => {
  const a = expectStatus(
    await request('POST', '/items', { kind: 'task', title: 'A 任务', precision: 'day', startDate: tomorrow }),
    200,
    'create A',
  );
  const b = expectStatus(
    await request('POST', '/items', { kind: 'task', title: 'B 任务', precision: 'day', startDate: tomorrow }),
    200,
    'create B',
  );
  const ok = expectStatus(
    await request('POST', '/dependencies', { fromId: a.id, toId: b.id }),
    200,
    'add dependency',
  );
  assert.equal(ok.fromId, a.id);
  assert.equal(ok.toId, b.id);

  const cycle = await request('POST', '/dependencies', { fromId: b.id, toId: a.id });
  assert.equal(cycle.status, 400, `expected 400 for cycle, got ${cycle.status}`);
  assert.equal(cycle.body.code, 'DEP_CYCLE');

  const self = await request('POST', '/dependencies', { fromId: a.id, toId: a.id });
  assert.equal(self.status, 400);
  assert.equal(self.body.code, 'DEP_SELF_LOOP');

  const list = expectStatus(await request('GET', `/dependencies?itemId=${a.id}`), 200, 'list deps');
  assert.equal(list.dependencies.length, 1);
  expectStatus(await request('DELETE', `/dependencies/${ok.id}`), 200, 'delete dep');
});

await test('14 /health is public, all other routes need token', async () => {
  const health = await request('GET', '/health', undefined, { auth: false });
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.ai, 'off');
  assert.equal(health.body.tz, 'Asia/Shanghai');

  for (const p of ['/items', '/settings', '/state', '/window', '/conflicts']) {
    const res = await request('GET', p, undefined, { auth: false });
    assert.equal(res.status, 401, `${p} should be 401 without token`);
    assert.equal(res.body.error, 'unauthorized');
  }
  const wrong = await request('GET', '/items', undefined, { token: 'deadbeef' });
  assert.equal(wrong.status, 401);
});

await test('15 /export contains no api key', async () => {
  const rejected = await request('PATCH', '/settings', { apiKey: 'sk-should-not-leak' });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, 'SECRET_KEY_NOT_ALLOWED');

  // 即使有人从旧备份导入密钥字段，也不能回显
  expectStatus(
    await request('POST', '/import', { mode: 'merge', prefs: { apiKey: 'sk-imported-leak' } }),
    200,
    'import secret pref',
  );
  const exported = expectStatus(await request('GET', '/export'), 200, 'export');
  const raw = JSON.stringify(exported);
  assert.ok(!raw.includes('sk-imported-leak'), 'export leaked imported key');
  assert.ok(!raw.toLowerCase().includes('apikey'), 'export contains apiKey field');
  assert.ok(!raw.toLowerCase().includes('token'), 'export contains token field');
  for (const key of ['version', 'exportedAt', 'items', 'dependencies', 'reminders', 'prefs', 'memory', 'history']) {
    assert.ok(Object.prototype.hasOwnProperty.call(exported, key), `export missing ${key}`);
  }
  const settings = expectStatus(await request('GET', '/settings'), 200, 'settings after import');
  assert.ok(!JSON.stringify(settings).includes('sk-imported-leak'), 'settings leaked key');
});

await test('16 /settings returns all defaults and validates types', async () => {
  const s = expectStatus(await request('GET', '/settings'), 200, 'get settings');
  const defaults = {
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
  };
  for (const [k, v] of Object.entries(defaults)) {
    assert.equal(s[k], v, `default ${k} should be ${v}, got ${s[k]}`);
  }
  assert.deepEqual(s.meals, ['11:00', '18:00']);
  assert.deepEqual(s.dnd, { active: false, from: '23:00', to: '07:00' });
  assert.deepEqual(s.notify, { system: true, pet: true, sound: false });

  const patched = expectStatus(
    await request('PATCH', '/settings', {
      slotMinutes: 45,
      meals: ['12:00', '19:00'],
      dnd: { active: false, from: '22:00', to: '07:00' },
    }),
    200,
    'patch settings',
  );
  assert.equal(patched.slotMinutes, 45);
  assert.deepEqual(patched.meals, ['12:00', '19:00']);
  assert.equal(patched.dnd.from, '22:00');

  const badInt = await request('PATCH', '/settings', { slotMinutes: 'abc' });
  assert.equal(badInt.status, 400);
  const badMeal = await request('PATCH', '/settings', { meals: ['25:00'] });
  assert.equal(badMeal.status, 400);

  const restored = expectStatus(
    await request('PATCH', '/settings', {
      slotMinutes: 30,
      meals: ['11:00', '18:00'],
      dnd: { active: false, from: '23:00', to: '07:00' },
    }),
    200,
    'restore settings',
  );
  assert.equal(restored.slotMinutes, 30);
});

await test('17 /boot/hello greets once per session and later creates a reminder', async () => {
  const sessionId = `test-session-${Date.now()}`;
  const first = expectStatus(
    await request('POST', '/boot/hello', { sessionId, kind: 'login' }),
    200,
    'boot hello first',
  );
  assert.equal(first.shouldGreet, true);
  assert.equal(first.sessionId, sessionId);
  assert.equal(first.summary.days, 5);
  assert.ok(Array.isArray(first.summary.dueSoon));
  assert.ok(typeof first.summary.planned === 'number');
  assert.ok(typeof first.summary.conflicts === 'number');
  assert.ok(first.summary.firstTask === null || typeof first.summary.firstTask === 'object');
  assert.deepEqual(first.actions, ['plan', 'view', 'later']);
  assert.ok(typeof first.greeting === 'string' && first.greeting.length > 0);

  const second = expectStatus(
    await request('POST', '/boot/hello', { sessionId, kind: 'login' }),
    200,
    'boot hello second',
  );
  assert.equal(second.shouldGreet, false, 'same sessionId must greet only once');
  assert.ok(second.summary, 'summary must still be returned when shouldGreet=false');

  const before = new Date();
  const ack = expectStatus(
    await request('POST', '/boot/ack', { sessionId, action: 'later' }),
    200,
    'boot ack later',
  );
  assert.equal(ack.ok, true);
  assert.equal(ack.snoozeMin, 30);
  assert.ok(ack.reminder && ack.reminder.id, 'later must create a reminder');
  assert.equal(ack.reminder.kind, 'boot');
  assert.equal(ack.reminder.status, 'pending');
  const fire = stampToDate(ack.reminder.fireAt);
  const mins = (fire - before) / 60000;
  assert.ok(mins >= 29 && mins <= 31.5, `expected ~30 min later, got ${mins}`);
});

await test('18 unscheduled items never get inferred dates', async () => {
  const item = expectStatus(
    await request('POST', '/items', {
      kind: 'task',
      title: '待安排：整理资料',
      precision: 'unscheduled',
      startDate: '2026-12-01',
      startTime: '09:00',
      endTime: '10:00',
    }),
    200,
    'create unscheduled',
  );
  assert.equal(item.precision, 'unscheduled');
  assert.equal(item.startDate, null);
  assert.equal(item.endDate, null);
  assert.equal(item.startTime, null);
  assert.equal(item.endTime, null);

  const win = expectStatus(await request('GET', '/window?days=5'), 200, 'window for pool');
  const candidate = win.unscheduledCandidates.find((c) => c.id === item.id);
  assert.ok(candidate, 'unscheduled item must appear in the pool');
  assert.equal(candidate.candidateReason, 'unscheduled');
  assert.equal(candidate.startDate, null);

  const conflicts = expectStatus(await request('GET', '/conflicts'), 200, 'conflicts');
  const noExec = conflicts.conflicts.filter((c) => c.type === 'no-execution');
  assert.ok(
    noExec.some((c) => c.itemIds.includes(quarterPlan.id)),
    'quarter plan without children must raise no-execution',
  );
});

await test('19 due-soon low progress raises due-risk conflict', async () => {
  const dueTask = expectStatus(
    await request('POST', '/items', {
      kind: 'task',
      title: '明天到期的报告',
      precision: 'day',
      startDate: tomorrow,
      dueDate: tomorrow,
      progress: 0,
    }),
    200,
    'create due task',
  );
  const conflicts = expectStatus(await request('GET', '/conflicts'), 200, 'conflicts');
  const risk = conflicts.conflicts.find(
    (c) => c.type === 'due-risk' && c.itemIds.includes(dueTask.id),
  );
  assert.ok(risk, `expected due-risk for ${dueTask.id}`);
  assert.equal(risk.severity, 'high');
  assert.ok(risk.message.includes('到期'));

  const dueDetail = expectStatus(await request('GET', `/items/${dueTask.id}`), 200, 'due task detail');
  const dueReminder = dueDetail.reminders.find((r) => r.kind === 'due');
  assert.ok(dueReminder, 'due reminder missing');
  assert.equal(dueReminder.fireAt, `${tomorrow}T09:00:00`);

  // 依赖冲突：前置未完成但后继已排期
  const a = expectStatus(
    await request('POST', '/items', { kind: 'task', title: '前置未完成', precision: 'day', startDate: tomorrow }),
    200,
    'create dep from',
  );
  const b = expectStatus(
    await request('POST', '/items', { kind: 'task', title: '后继已排期', precision: 'slot', startDate: tomorrow, startTime: '20:00', endTime: '21:00' }),
    200,
    'create dep to',
  );
  expectStatus(await request('POST', '/dependencies', { fromId: a.id, toId: b.id }), 200, 'dep for conflict');
  const after = expectStatus(await request('GET', '/conflicts'), 200, 'conflicts with dep');
  const depConflict = after.conflicts.find(
    (c) => c.type === 'dependency' && c.itemIds.includes(a.id) && c.itemIds.includes(b.id),
  );
  assert.ok(depConflict, 'dependency conflict missing');
});

await test('20 timeline shows fuzzy interval and precision', async () => {
  const timeline = expectStatus(
    await request('GET', '/timeline?from=2027-01-01&to=2027-12-31&scale=year'),
    200,
    'timeline',
  );
  assert.equal(timeline.range.from, '2027-01-01');
  assert.equal(timeline.range.to, '2027-12-31');
  const row = timeline.rows.find((r) => r.item.id === yearGoal.id);
  assert.ok(row, 'year goal missing from timeline');
  assert.equal(row.precision, 'year');
  assert.equal(row.start, '2027-01-01');
  assert.equal(row.end, '2027-12-31');
  assert.ok(Array.isArray(timeline.milestones));
  const quarterRow = timeline.rows.find((r) => r.item.id === quarterPlan.id);
  assert.ok(quarterRow);
  assert.equal(quarterRow.start, '2027-04-01');
  assert.equal(quarterRow.end, '2027-06-30');
});

await test('21 stats and due queue are consistent', async () => {
  const stats = expectStatus(await request('GET', '/stats'), 200, 'stats');
  assert.ok(stats.items > 0);
  assert.ok(stats.reminders.pending >= 0);
  assert.ok(stats.dbBytes > 0);
  assert.ok(stats.rssBytes > 0);

  // 手动加一条已经到期的提醒，/reminders/due 应弹出并标记 fired，第二次不再弹
  const past = new Date(Date.now() - 60000);
  const fireAt = `${todayStr(past)}T${String(past.getHours()).padStart(2, '0')}:${String(past.getMinutes()).padStart(2, '0')}:00`;
  const manual = expectStatus(
    await request('POST', '/reminders', {
      title: '已到期的自定义提醒',
      fireAt,
      kind: 'custom',
    }),
    200,
    'manual reminder',
  );
  assert.equal(manual.inserted, true);
  const due = expectStatus(await request('GET', '/reminders/due'), 200, 'due');
  assert.ok(due.items.some((r) => r.id === manual.id), 'manual due reminder should pop');
  assert.deepEqual(due.items[0].actions, ['start', 'done', 'snooze', 'skip', 'open']);
  const dueAgain = expectStatus(await request('GET', '/reminders/due'), 200, 'due again');
  assert.ok(!dueAgain.items.some((r) => r.id === manual.id), 'fired reminder must not pop twice');
});

await test('22 export/import replace roundtrip keeps data', async () => {
  const exported = expectStatus(await request('GET', '/export'), 200, 'export for roundtrip');
  const beforeStats = expectStatus(await request('GET', '/stats'), 200, 'stats before import');
  const imported = expectStatus(
    await request('POST', '/import', { ...exported, mode: 'replace' }),
    200,
    'import replace',
  );
  assert.equal(imported.mode, 'replace');
  assert.equal(imported.items, exported.items.length);
  const afterStats = expectStatus(await request('GET', '/stats'), 200, 'stats after import');
  assert.equal(afterStats.items, beforeStats.items);
  const yearAfter = expectStatus(await request('GET', `/items/${yearGoal.id}`), 200, 'year goal after import');
  assert.equal(yearAfter.startDate, '2027-01-01');
  assert.equal(yearAfter.endDate, '2027-12-31');

  // merge 同一份数据不应产生重复
  const merged = expectStatus(
    await request('POST', '/import', { ...exported, mode: 'merge' }),
    200,
    'import merge',
  );
  assert.equal(merged.itemsUpdated, exported.items.length);
  const mergedStats = expectStatus(await request('GET', '/stats'), 200, 'stats after merge');
  assert.equal(mergedStats.items, beforeStats.items);
});

await test('23 restart catch-up: pending due reminder is delivered once, stale start expires', async () => {
  const now = new Date();
  const minsAgo = (n) => {
    const d = new Date(now.getTime() - n * 60000);
    return `${todayStr(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
  };
  const recent = expectStatus(
    await request('POST', '/reminders', {
      title: '补发测试',
      fireAt: minsAgo(2),
      kind: 'custom',
      dedupeKey: 'test:catchup:recent',
    }),
    200,
    'create recent reminder',
  );
  const stale = expectStatus(
    await request('POST', '/reminders', {
      title: '两天前的开始提醒',
      fireAt: minsAgo(2 * 24 * 60),
      kind: 'start',
      dedupeKey: 'test:catchup:stale',
    }),
    200,
    'create stale reminder',
  );

  await svc.close();
  await startService();

  const due = expectStatus(await request('GET', '/reminders/due'), 200, 'due after catch-up restart');
  assert.ok(due.items.some((r) => r.id === recent.id), 'recent pending reminder must be delivered after restart');
  assert.ok(!due.items.some((r) => r.id === stale.id), 'stale start reminder must not be delivered');

  const allRows = expectStatus(await request('GET', '/reminders?limit=1000'), 200, 'all reminders');
  const staleRow = allRows.find((r) => r.id === stale.id);
  assert.ok(staleRow, 'stale reminder row should still exist for audit');
  assert.equal(staleRow.status, 'cancelled');
  const recentRow = allRows.find((r) => r.id === recent.id);
  assert.equal(recentRow.status, 'fired');
  assert.ok(recentRow.catchup === 1, 'catch-up flag should be set');

  // 再重启一次，已 fired 的不会重新弹
  await svc.close();
  await startService();
  const dueAgain = expectStatus(await request('GET', '/reminders/due'), 200, 'due after second restart');
  assert.ok(!dueAgain.items.some((r) => r.id === recent.id), 'fired reminder must not pop again');
});

await test('24 /ai/simulate is pure and returns baseline/alternative/diff/risks', async () => {
  const beforeItems = expectStatus(await request('GET', '/items?limit=2000'), 200, 'items before simulate');
  const beforeWindow = expectStatus(await request('GET', '/window?days=5'), 200, 'window before simulate');

  const res = expectStatus(
    await request('POST', '/ai/simulate', { scenario: '把所有任务推迟 2 天', days: 5 }),
    200,
    'simulate delay',
  );
  assert.ok(res.baseline && typeof res.baseline.totalMin === 'number');
  assert.ok(res.alternative && typeof res.alternative.totalMin === 'number');
  assert.ok(Array.isArray(res.diff));
  assert.ok(Array.isArray(res.risks) && res.risks.length > 0);
  assert.ok(Array.isArray(res.affected) && res.affected.length > 0);
  assert.equal(res.applied.shiftDays, 2);
  assert.ok(res.diff.length >= 1, 'shifting schedules should produce a non-empty diff');

  const res2 = expectStatus(
    await request('POST', '/ai/simulate', { scenario: '每天最多 2 小时，帮我看看', days: 5 }),
    200,
    'simulate capacity',
  );
  assert.equal(res2.applied.dailyCapMin, 120);
  assert.ok(res2.risks.length > 0);

  const afterItems = expectStatus(await request('GET', '/items?limit=2000'), 200, 'items after simulate');
  const afterWindow = expectStatus(await request('GET', '/window?days=5'), 200, 'window after simulate');
  assert.equal(afterItems.total, beforeItems.total, 'simulate must not create items');
  assert.equal(afterWindow.summary.totalMin, beforeWindow.summary.totalMin, 'simulate must not move items');
});

await test('25 /ai/analyze returns findings from real conflicts', async () => {
  const res = expectStatus(await request('POST', '/ai/analyze', { scope: '5d' }), 200, 'analyze 5d');
  assert.equal(res.mode, 'fallback');
  assert.equal(res.scope, '5d');
  assert.ok(typeof res.summary === 'string' && res.summary.length > 0);
  assert.ok(Array.isArray(res.findings));
  assert.ok(res.stats.conflicts === res.findings.length);
  assert.ok(res.findings.length >= 1, 'fixture should contain conflicts');
  for (const f of res.findings) {
    assert.ok(f.type && f.message && f.suggestion && f.severity);
  }
});

await test('26 /ai/chat answers with real context numbers', async () => {
  const res = expectStatus(
    await request('POST', '/ai/chat', { text: '今天安排得怎么样？' }),
    200,
    'chat',
  );
  assert.equal(res.mode, 'fallback');
  assert.ok(typeof res.reply === 'string' && res.reply.length > 0);
  assert.ok(res.usedContext.items > 0, 'usedContext.items should be > 0');
});

await test('27 /ai/create-from-text writes only when 确认', async () => {
  const before = expectStatus(await request('GET', '/items?limit=2000'), 200, 'items before create-from-text');

  const preview = expectStatus(
    await request('POST', '/ai/create-from-text', {
      text: '明天下午三点到五点写方案',
      confirm: false,
    }),
    200,
    'preview only',
  );
  assert.equal(preview.applied, false);
  assert.equal(preview.created.length, 0);
  assert.equal(preview.preview.length, 1);
  const mid = expectStatus(await request('GET', '/items?limit=2000'), 200, 'items after preview');
  assert.equal(mid.total, before.total, 'confirm:false must not write');

  const applied = expectStatus(
    await request('POST', '/ai/create-from-text', {
      text: '明天下午三点到五点写方案',
      confirm: true,
    }),
    200,
    'apply create-from-text',
  );
  assert.equal(applied.applied, true);
  assert.equal(applied.created.length, 1);
  const item = applied.created[0];
  assert.equal(item.precision, 'slot');
  assert.equal(item.startTime, '15:00');
  assert.equal(item.endTime, '17:00');
  assert.equal(item.source, 'ai');
  const after = expectStatus(await request('GET', '/items?limit=2000'), 200, 'items after apply');
  assert.equal(after.total, before.total + 1);
});

await test('28 /focus and /dnd persist and appear in /state', async () => {
  const focusOn = expectStatus(
    await request('POST', '/focus', { active: true, minutes: 45, note: '写测试' }),
    200,
    'focus on',
  );
  assert.equal(focusOn.active, true);
  assert.ok(focusOn.startedAt);
  assert.ok(focusOn.plannedEndAt);

  const state = expectStatus(await request('GET', '/state'), 200, 'state with focus');
  assert.equal(state.focus.active, true);
  assert.equal(state.focus.note, '写测试');
  assert.equal(state.ai.mode, 'fallback');
  assert.equal(state.tz, 'Asia/Shanghai');

  const focusOff = expectStatus(await request('POST', '/focus', { active: false }), 200, 'focus off');
  assert.equal(focusOff.active, false);

  const dndOn = expectStatus(
    await request('POST', '/dnd', { active: true, until: '23:59' }),
    200,
    'dnd on',
  );
  assert.equal(dndOn.active, true);
  assert.ok(dndOn.until, 'dnd.until should be computed');
  const state2 = expectStatus(await request('GET', '/state'), 200, 'state with dnd');
  assert.equal(state2.dnd.active, true);

  const dndOff = expectStatus(await request('POST', '/dnd', { active: false }), 200, 'dnd off');
  assert.equal(dndOff.active, false);
});

await test('29 scheduler creates water / meal / rest reminders and dedupes', async () => {
  const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000);
  const pastStamp = `${todayStr(threeHoursAgo)}T${String(threeHoursAgo.getHours()).padStart(2, '0')}:${String(threeHoursAgo.getMinutes()).padStart(2, '0')}:00`;
  expectStatus(
    await request('POST', '/reminders', {
      kind: 'water',
      title: '上次喝水',
      fireAt: pastStamp,
      dedupeKey: 'water:test-anchor',
    }),
    200,
    'seed water anchor',
  );
  // 把这条锚点标记为已处理，否则调度器会因为"已有一条 pending 喝水"而不再新增
  const anchorRow = expectStatus(await request('GET', '/reminders?kind=water&limit=50'), 200, 'find anchor');
  const anchor = anchorRow.find((r) => r.dedupeKey === 'water:test-anchor');
  expectStatus(await request('POST', `/reminders/${anchor.id}/ack`, { action: 'skip' }), 200, 'ack anchor');

  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  expectStatus(
    await request('PATCH', '/settings', { waterEveryMin: 120, meals: [hhmm] }),
    200,
    'settings for scheduler',
  );

  // 让休息规则也有一个进行中的工作会话：直接写 prefs（白盒）
  const startedAt = new Date(now.getTime() - 60 * 60000);
  const startStamp = `${todayStr(startedAt)}T${String(startedAt.getHours()).padStart(2, '0')}:${String(startedAt.getMinutes()).padStart(2, '0')}:00`;
  writePref(svc.db, 'focus', { active: true, startedAt: startStamp, plannedEndAt: null, note: '测试' });

  const tick = svc.scheduler.tick();
  assert.ok(tick && !tick.error, `scheduler tick failed: ${JSON.stringify(tick)}`);

  const water = expectStatus(await request('GET', '/reminders?kind=water&status=pending'), 200, 'water pending');
  const autoWater = water.filter((r) => r.dedupeKey.startsWith('water:') && r.dedupeKey !== 'water:test-anchor');
  assert.equal(autoWater.length, 1, `expected 1 auto water reminder, got ${water.length}`);
  assert.ok(autoWater[0].fireAt >= `${todayStr()}T00:00:00`);

  const meals = expectStatus(await request('GET', '/reminders?kind=meal&status=pending'), 200, 'meal pending');
  assert.equal(meals.length, 1);
  assert.equal(meals[0].dedupeKey, `meal:${todayStr()}:${hhmm}`);

  const rests = expectStatus(await request('GET', '/reminders?kind=rest&status=pending'), 200, 'rest pending');
  assert.ok(rests.length >= 1, 'rest reminder should be created for a 60-minute focus session');
  assert.ok(rests[0].dedupeKey.startsWith('rest:focus:'));

  // 再 tick 一次不产生重复
  svc.scheduler.tick();
  const water2 = expectStatus(await request('GET', '/reminders?kind=water&status=pending'), 200, 'water again');
  assert.equal(water2.filter((r) => r.dedupeKey.startsWith('water:') && r.dedupeKey !== 'water:test-anchor').length, 1);
  const meals2 = expectStatus(await request('GET', '/reminders?kind=meal&status=pending'), 200, 'meal again');
  assert.equal(meals2.length, 1, 'meal must fire only once per day');

  const ack = expectStatus(await request('POST', '/water/ack'), 200, 'water ack');
  assert.ok(ack.acked >= 2, `water/ack should ack water+rest, got ${ack.acked}`);

  // 复位
  expectStatus(await request('PATCH', '/settings', { meals: ['11:00', '18:00'], waterEveryMin: 120 }), 200, 'reset settings');
  expectStatus(await request('POST', '/focus', { active: false }), 200, 'reset focus');
});

await test('30 proposal reject and lock endpoint', async () => {
  const item = expectStatus(
    await request('POST', '/items', {
      kind: 'task',
      title: '锁测试',
      precision: 'day',
      startDate: tomorrow,
    }),
    200,
    'create lock candidate',
  );
  expectStatus(await request('POST', `/items/${item.id}/lock`, { locked: true }), 200, 'lock');
  const locked = expectStatus(await request('GET', `/items/${item.id}`), 200, 'get locked');
  assert.equal(locked.locked, 1);
  const blocked = await request('PATCH', `/items/${item.id}`, { title: 'x', source: 'ai' });
  assert.equal(blocked.status, 409);
  expectStatus(await request('POST', `/items/${item.id}/lock`, { locked: false }), 200, 'unlock');
  expectStatus(await request('PATCH', `/items/${item.id}`, { title: '解锁后改名', source: 'ai' }), 200, 'ai patch after unlock');

  const proposal = expectStatus(
    await request('POST', '/proposals', {
      title: '拒绝测试',
      ops: [{ op: 'create', item: { kind: 'task', title: '不该被创建', precision: 'day', startDate: tomorrow } }],
    }),
    200,
    'create rejection proposal',
  );
  const rejected = expectStatus(await request('POST', `/proposals/${proposal.id}/reject`), 200, 'reject');
  assert.equal(rejected.status, 'rejected');
  const acceptAgain = await request('POST', `/proposals/${proposal.id}/accept`);
  assert.equal(acceptAgain.status, 400);
  assert.equal(acceptAgain.body.code, 'PROPOSAL_NOT_DRAFT');
  const items = expectStatus(await request('GET', `/items?q=${encodeURIComponent('不该被创建')}`), 200, 'query');
  assert.equal(items.total, 0, 'rejected proposal must not create items');
});

await test('31 delete detaches children and cancels reminders', async () => {
  const parent = expectStatus(
    await request('POST', '/items', {
      kind: 'project',
      title: '待删除父项',
      precision: 'month',
      startDate: '2027-08-01',
    }),
    200,
    'create parent',
  );
  const child = expectStatus(
    await request('POST', '/items', {
      kind: 'task',
      title: '子任务保留',
      precision: 'slot',
      startDate: tomorrow,
      startTime: '06:00',
      endTime: '07:00',
      parentId: parent.id,
    }),
    200,
    'create child',
  );
  assert.equal(child.parentId, parent.id);
  const childDetail = expectStatus(await request('GET', `/items/${child.id}`), 200, 'child detail');
  const childReminder = childDetail.reminders.find((r) => r.kind === 'start');

  const del = expectStatus(await request('DELETE', `/items/${parent.id}`), 200, 'delete parent');
  assert.equal(del.deleted, true);

  const childAfter = expectStatus(await request('GET', `/items/${child.id}`), 200, 'child after delete');
  assert.equal(childAfter.parentId, null, 'child must be detached, not deleted');
  const reminderAfter = expectStatus(
    await request('GET', `/reminders?itemId=${child.id}&status=pending`),
    200,
    'child reminders',
  );
  assert.ok(reminderAfter.some((r) => r.id === childReminder.id), 'child reminder must survive');

  // 删除有提醒的项：pending 提醒被取消
  const doomed = expectStatus(
    await request('POST', '/items', {
      kind: 'task',
      title: '待删除任务',
      precision: 'slot',
      startDate: tomorrow,
      startTime: '06:30',
      endTime: '07:30',
    }),
    200,
    'create doomed',
  );
  const doomedDetail = expectStatus(await request('GET', `/items/${doomed.id}`), 200, 'doomed detail');
  const doomedReminder = doomedDetail.reminders.find((r) => r.kind === 'start');
  expectStatus(await request('DELETE', `/items/${doomed.id}`), 200, 'delete doomed');
  const cancelled = expectStatus(
    await request('GET', `/reminders?itemId=${doomed.id}&status=cancelled`),
    200,
    'cancelled reminders',
  );
  assert.ok(cancelled.some((r) => r.id === doomedReminder.id), 'deleted item reminders must be cancelled');
});

await test('32 /window clamps days to 1..14 and /items filters work', async () => {
  const w1 = expectStatus(await request('GET', '/window?days=1'), 200, 'window 1 day');
  assert.equal(w1.days.length, 1);
  const w14 = expectStatus(await request('GET', '/window?days=14'), 200, 'window 14 days');
  assert.equal(w14.days.length, 14);
  const w99 = expectStatus(await request('GET', '/window?days=99'), 200, 'window 99 days');
  assert.equal(w99.days.length, 14);

  const yearItems = expectStatus(await request('GET', '/items?kind=goal&limit=10'), 200, 'filter kind');
  assert.ok(yearItems.items.every((i) => i.kind === 'goal'));
  const unscheduled = expectStatus(await request('GET', '/items?unscheduled=1&limit=20'), 200, 'filter unscheduled');
  assert.ok(unscheduled.items.every((i) => i.precision === 'unscheduled'));
  const byText = expectStatus(
    await request('GET', `/items?q=${encodeURIComponent('写项目方案')}`),
    200,
    'filter q',
  );
  assert.ok(byText.items.some((i) => i.title.includes('写项目方案')));
});

await test('33 api mode uses model ops through injected endpoint', async () => {
  const mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  intent: 'create',
                  ops: [
                    {
                      op: 'create',
                      item: {
                        kind: 'goal',
                        title: '模型解析的目标',
                        precision: 'year',
                        startDate: '2029-01-01',
                      },
                    },
                  ],
                  questions: [],
                  confidence: 0.95,
                }),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = mock.address().port;
  const apiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-secretary-api-'));
  let svc2 = null;
  try {
    svc2 = await createService({
      dataDir: apiDir,
      port: 0,
      aiKey: 'sk-test-mock-key',
      aiEndpoint: `http://127.0.0.1:${mockPort}/chat/completions`,
      aiTimeoutMs: 3000,
      tickMs: 60000,
    });
    const api2 = makeApi(svc2.port, svc2.token);
    const health = await api2('GET', '/health');
    assert.equal(health.body.ai, 'api');

    const parsed = await api2('POST', '/ai/parse', { text: '2029年系统研究大模型' });
    assert.equal(parsed.status, 200);
    assert.equal(parsed.body.mode, 'api');
    assert.equal(parsed.body.model, 'deepseek-chat');
    assert.equal(parsed.body.ops.length, 1);
    assert.equal(parsed.body.ops[0].item.precision, 'year');
    assert.equal(parsed.body.ops[0].item.title, '模型解析的目标');

    // /ai/parse 不写库
    const items = await api2('GET', '/items');
    assert.equal(items.body.total, 0);

    const state = await api2('GET', '/state');
    assert.equal(state.body.ai.mode, 'api');
    assert.equal(state.body.ai.model, 'deepseek-chat');
  } finally {
    if (svc2) await svc2.close();
    await new Promise((resolve) => mock.close(resolve));
    fs.rmSync(apiDir, { recursive: true, force: true });
  }
});

await test('34 api failures degrade to local fallback (timeout / refused)', async () => {
  // 先占一个端口再关掉，制造"连接被拒绝"
  const probe = http.createServer((req, res) => res.end('{}'));
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-secretary-fb-'));
  let svc3 = null;
  try {
    svc3 = await createService({
      dataDir: fallbackDir,
      port: 0,
      aiKey: 'sk-test-bad-key',
      aiEndpoint: `http://127.0.0.1:${deadPort}/chat/completions`,
      aiTimeoutMs: 1200,
      tickMs: 60000,
    });
    const api3 = makeApi(svc3.port, svc3.token);
    const t0 = Date.now();
    const res = await api3('POST', '/ai/parse', { text: '2027年我想系统地研究AI' });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 200, 'must not fail the request when model is unavailable');
    assert.equal(res.body.degraded, true);
    assert.equal(res.body.ops[0].item.precision, 'year');
    assert.ok(elapsed < 5000, `fallback should be fast, took ${elapsed}ms`);
  } finally {
    if (svc3) await svc3.close();
    fs.rmSync(fallbackDir, { recursive: true, force: true });
  }
});

await test('35 week/day precision, padded HH:mm, and /tree', async () => {
  const wednesday = '2027-03-10';
  const week = expectStatus(
    await request('POST', '/items', {
      kind: 'phase',
      title: '第 11 周计划',
      precision: 'week',
      startDate: wednesday,
    }),
    200,
    'create week item',
  );
  assert.equal(week.startDate, '2027-03-08', 'week must snap to ISO Monday');
  assert.equal(week.endDate, '2027-03-14');

  const day = expectStatus(
    await request('POST', '/items', {
      kind: 'task',
      title: '全天任务',
      precision: 'day',
      startDate: wednesday,
      startTime: '09:00',
      endTime: '10:00',
    }),
    200,
    'create day item',
  );
  assert.equal(day.startDate, wednesday);
  assert.equal(day.endDate, wednesday);
  assert.equal(day.startTime, null, 'day precision must not keep a time');
  assert.equal(day.endTime, null);

  const slot = expectStatus(
    await request('POST', '/items', {
      kind: 'task',
      title: '补零测试',
      precision: 'slot',
      startDate: wednesday,
      startTime: '9:05',
      endTime: '10:00',
    }),
    200,
    'create slot with unpadded time',
  );
  assert.equal(slot.startTime, '09:05');
  assert.equal(slot.endTime, '10:00');

  const parent = expectStatus(
    await request('POST', '/items', {
      kind: 'project',
      title: '树形父节点',
      precision: 'month',
      startDate: '2027-09-01',
    }),
    200,
    'create tree parent',
  );
  const child = expectStatus(
    await request('POST', '/items', {
      kind: 'task',
      title: '树形子节点',
      precision: 'day',
      startDate: '2027-09-02',
      parentId: parent.id,
    }),
    200,
    'create tree child',
  );

  const tree = expectStatus(await request('GET', '/tree'), 200, 'tree');
  const parentNode = tree.nodes.find((n) => n.item.id === parent.id);
  assert.ok(parentNode, 'parent node missing from tree');
  assert.ok(parentNode.children.some((c) => c.item.id === child.id), 'child not nested under parent');

  const byParent = expectStatus(await request('GET', `/items?parentId=${parent.id}`), 200, 'filter parentId');
  assert.equal(byParent.total, 1);
  assert.equal(byParent.items[0].id, child.id);

  // 父节点不能是 task
  const badParent = await request('POST', '/items', {
    kind: 'task',
    title: '错误的父子关系',
    precision: 'day',
    startDate: wednesday,
    parentId: slot.id,
  });
  assert.equal(badParent.status, 400);
  assert.equal(badParent.body.code, 'PARENT_IS_TASK');
});

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

try {
  if (svc) await svc.close();
} catch (err) {
  console.log(`WARN  cleanup close failed: ${err && err.message ? err.message : err}`);
}
try {
  if (!process.env.KEEP_TEST_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
  else console.log(`INFO  test data kept at ${dataDir}`);
} catch {
  /* 清理失败不影响结果 */
}

console.log('');
console.log('='.repeat(64));
console.log(`TEST SUMMARY: ${passed} passed, ${failed} failed, ${results.length} total`);
if (failed > 0) {
  console.log('FAILED CASES:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}`);
}
console.log('='.repeat(64));

process.exit(failed > 0 ? 1 : 0);
