// AI 层：DeepSeek 调用 + 本地确定性兜底。
// 铁律：
//  - 没有 Key 时全部走 fallback，mode:"fallback"，绝不伪造模型输出；
//  - 模型返回的任何 op 都必须过 model.normalizeItem 校验，不合法就整体降级；
//  - /ai/plan 只产出 draft proposal，绝不直接写 items；
//  - /ai/simulate 完全本地计算，不写库、不联网；
//  - 注入模型的上下文只来自真实 DB 摘要。
import fs from 'node:fs';
import path from 'node:path';
import {
  createItem,
  createProposal,
  normalizeItem,
  getItem,
  updateItem,
  deleteItem,
  countItems,
  rowToItem,
} from './model.mjs';
import { all, get, readPrefs } from './db.mjs';
import {
  addDays,
  describeInterval,
  nowStamp,
  today,
  weekdayLabel,
} from './time.mjs';
import { buildWindow, computeConflicts, proposePlacements, simulate } from './planner.mjs';
import { parseText, findItemByText } from './nlq.mjs';
import { unscheduledCandidates } from './model.mjs';

export const AI_MODEL = 'deepseek-chat';
export const AI_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_TIMEOUT_MS = 15000;

export function loadAiKey({ configPath, env = process.env } = {}) {
  if (env.DEEPSEEK_API_KEY && String(env.DEEPSEEK_API_KEY).trim()) {
    return String(env.DEEPSEEK_API_KEY).trim();
  }
  if (configPath) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const json = JSON.parse(raw);
      const key = json.apiKey || json.deepseekApiKey;
      if (typeof key === 'string' && key.trim()) return key.trim();
    } catch {
      /* 没有配置文件是正常情况 */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 上下文：只用真实 DB 数据
// ---------------------------------------------------------------------------

export function buildContext(db, { days = 5, prefs, now = new Date(), maxItems = 20 } = {}) {
  const windowData = buildWindow(db, { days, prefs, now });
  const conflicts = computeConflicts(db, { now, prefs });
  const items = all(
    db,
    `SELECT * FROM items WHERE status NOT IN ('done','cancelled')
     ORDER BY CASE WHEN startDate IS NULL THEN 1 ELSE 0 END, startDate ASC, priority DESC, createdAt ASC
     LIMIT ?`,
    Math.max(20, Math.min(200, Number(maxItems) || 20)),
  ).map(rowToItem);
  const goals = items.filter(
    (i) => i.kind === 'goal' || i.kind === 'project' || ['year', 'quarter'].includes(i.precision),
  );
  const dueSoon = items
    .filter((i) => i.dueDate && i.dueDate >= today(now) && i.dueDate <= addDays(today(now), 7))
    .map((i) => ({ id: i.id, title: i.title, dueDate: i.dueDate }));
  return {
    now: nowStamp(now),
    days,
    counts: {
      items: countItems(db),
      active: items.length,
      unscheduled: items.filter((i) => i.precision === 'unscheduled').length,
    },
    window: windowData.summary,
    windowDays: windowData.days.map((d) => ({
      date: d.date,
      weekday: d.weekday,
      loadMin: d.loadMin,
      items: d.items.map((i) => ({
        id: i.id,
        title: i.title,
        precision: i.precision,
        startTime: i.startTime,
        endTime: i.endTime,
        status: i.status,
      })),
      freeSlots: d.freeSlots.slice(0, 6),
    })),
    conflicts: conflicts.slice(0, 12).map((c) => ({
      type: c.type,
      severity: c.severity,
      message: c.message,
      itemIds: c.itemIds,
    })),
    unscheduled: items
      .filter((i) => i.precision === 'unscheduled')
      .slice(0, 15)
      .map((i) => ({ id: i.id, kind: i.kind, title: i.title, dueDate: i.dueDate, priority: i.priority })),
    goals: goals.slice(0, 10).map((g) => ({
      id: g.id,
      title: g.title,
      precision: g.precision,
      interval: describeInterval(g),
      progress: g.progress,
      status: g.status,
    })),
    dueSoon,
    items: items.slice(0, Math.max(20, Math.min(200, Number(maxItems) || 20))).map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      precision: i.precision,
      startDate: i.startDate,
      endDate: i.endDate,
      startTime: i.startTime,
      endTime: i.endTime,
      dueDate: i.dueDate,
      status: i.status,
      progress: i.progress,
      priority: i.priority,
    })),
  };
}

function contextText(ctx) {
  const lines = [];
  lines.push(`现在：${ctx.now}（本地墙上时间）`);
  lines.push(
    `计划项总数 ${ctx.counts.items}，未完成 ${ctx.counts.active}，待安排 ${ctx.counts.unscheduled}。`,
  );
  lines.push(
    `未来 ${ctx.days} 天：共 ${ctx.window.totalMin} 分钟安排，${ctx.window.busyDays} 天有安排，最紧的一天是 ${ctx.window.tightestDay || '无'}。`,
  );
  for (const d of ctx.windowDays) {
    if (!d.items.length) continue;
    lines.push(
      `${d.date}（${d.weekday}）${d.loadMin} 分钟：` +
        d.items
          .map((i) => `${i.title}${i.startTime ? ` ${i.startTime}-${i.endTime}` : `（${i.precision}）`}`)
          .join('；'),
    );
  }
  if (ctx.items && ctx.items.length) {
    lines.push('全部未完成计划（id｜类型｜标题｜精度｜日期｜状态）：');
    for (const i of ctx.items) {
      const when = i.startDate
        ? `${i.startDate}${i.startTime ? ' ' + i.startTime + '-' + i.endTime : ''}`
        : '未定时间';
      lines.push(`- ${i.id}｜${i.kind}｜${i.title}｜${i.precision}｜${when}｜${i.status}`);
    }
  }
  if (ctx.unscheduled && ctx.unscheduled.length) {
    lines.push('待安排（还没定时间，可以建议排进空档）：');
    for (const u of ctx.unscheduled) {
      lines.push(`- ${u.title}${u.dueDate ? `（截止 ${u.dueDate}）` : ''}｜优先级 ${u.priority}`);
    }
  }
  if (ctx.goals.length) {
    lines.push('长期目标：');
    for (const g of ctx.goals) lines.push(`- ${g.title}｜${g.interval}｜进度 ${g.progress}%`);
  }
  if (ctx.dueSoon.length) {
    lines.push(`7 天内到期：${ctx.dueSoon.map((d) => `${d.title}(${d.dueDate})`).join('、')}`);
  }
  if (ctx.conflicts.length) {
    lines.push('已检测到的冲突：');
    for (const c of ctx.conflicts) lines.push(`- [${c.type}/${c.severity}] ${c.message}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 模型调用
// ---------------------------------------------------------------------------

function stripCodeFence(s) {
  const t = String(s || '').trim();
  if (!t.startsWith('```')) return t;
  return t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
}

export function createAI({
  db,
  prefsRef,
  log = () => {},
  aiKey = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  endpoint = AI_ENDPOINT,
  nowFn = () => new Date(),
}) {
  const mode = aiKey ? 'api' : 'fallback';
  const stats = { calls: 0, failures: 0, lastError: null, lastCallAt: null };

  const currentPrefs = () => (prefsRef ? prefsRef() : readPrefs(db));

  async function callModel(messages, { json = true, maxTokens = 1500 } = {}) {
    if (!aiKey) return { ok: false, error: 'no-api-key' };
    stats.calls += 1;
    stats.lastCallAt = nowStamp();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aiKey}`,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages,
          temperature: 0.2,
          max_tokens: maxTokens,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : null;
      if (!content) throw new Error('empty completion');
      stats.lastError = null;
      if (!json) return { ok: true, content: String(content) };
      let parsed;
      try {
        parsed = JSON.parse(stripCodeFence(content));
      } catch {
        throw new Error('model returned non-JSON');
      }
      return { ok: true, data: parsed, raw: content };
    } catch (err) {
      stats.failures += 1;
      stats.lastError = err && err.name === 'AbortError' ? 'timeout' : err && err.message ? err.message : String(err);
      log('warn', `deepseek call failed, using fallback: ${stats.lastError}`);
      return { ok: false, error: stats.lastError };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- 校验模型给的结构化 op ----
  // 模型有时给 id，有时只给标题（或 target/name 字段）：统一解析成真实 id
  function itemsForHint() {
    try {
      return all(
        db,
        "SELECT title FROM items WHERE status NOT IN ('done','cancelled') ORDER BY updatedAt DESC LIMIT 8",
      ).map((r) => String(r.title || '')).filter(Boolean).join('、');
    } catch { return ''; }
  }

  function resolveTargetId(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id === 'string' && raw.id && getItem(db, raw.id)) return raw.id;
    const nameHint = raw.title || raw.target || raw.name || raw.itemTitle;
    if (typeof nameHint === 'string' && nameHint.trim()) {
      const hit = findItemByText(db, nameHint);
      if (hit) return hit.id;
    }
    return typeof raw.id === 'string' && raw.id ? raw.id : null;
  }

  // 模型很爱换键名（action/type），也常常一条写坏。这里逐条校验：
  // tolerant=true 时丢掉坏的那条、保留好的，并把原因回报给调用方。
  function validateOps(ops, { tolerant = false, rejected = null } = {}) {
    if (!Array.isArray(ops)) {
      if (tolerant) return [];
      throw new Error('ops is not an array');
    }
    const clean = [];
    for (const raw of ops) {
      try {
        if (!raw || typeof raw !== 'object') throw new Error('op is not an object');
        const name = raw.op || raw.action || raw.type
          || (raw.item ? 'create' : raw.patch ? 'update' : raw.id ? 'delete' : undefined);
        if (name === 'create') {
          if (!raw.item || typeof raw.item !== 'object') throw new Error('create without item');
          normalizeItem({ ...raw.item, source: 'ai' }, { db }); // 校验，不写库
          clean.push({ op: 'create', item: raw.item });
        } else if (name === 'update') {
          const rid = resolveTargetId(raw);
          if (!rid) throw new Error('update without id');
          const target = getItem(db, rid);
          if (!target) throw new Error(`update target ${raw.id} not found`);
          normalizeItem({ ...target, ...(raw.patch || {}), source: 'ai' }, { db, selfId: rid });
          clean.push({ op: 'update', id: rid, patch: raw.patch || {} });
        } else if (name === 'delete') {
          const rid = resolveTargetId(raw);
          if (!rid) throw new Error('delete without id');
          if (!getItem(db, rid)) throw new Error(`delete target ${rid} not found`);
          clean.push({ op: 'delete', id: rid });
        } else {
          throw new Error(`unknown op ${name}`);
        }
      } catch (err) {
        if (!tolerant) throw err;
        if (Array.isArray(rejected)) rejected.push(err.message);
      }
    }
    return clean;
  }

  function apiStatus() {
    return {
      mode,
      model: mode === 'api' ? AI_MODEL : null,
      timeoutMs,
      calls: stats.calls,
      failures: stats.failures,
      lastError: stats.lastError,
    };
  }

  // -------------------------------------------------------------------------
  // /ai/parse
  // -------------------------------------------------------------------------

  // 纯寒暄/致谢不生成任何计划操作，直接走对话
  const CHITCHAT = /^(你好|您好|hi|hello|嗨|哈喽|在吗|在不在|早上好|上午好|中午好|下午好|晚上好|晚安|谢谢|多谢|好的|收到|嗯+|ok)[\s!！。.~～,，]*$/i;

  async function parse(text, { now = nowFn() } = {}) {
    const raw0 = String(text || '').trim();
    if (CHITCHAT.test(raw0)) {
      return { intent: 'query', ops: [], questions: [], confidence: 0.95, parsed: null, mode, model: null };
    }
    const local = parseText(text, { now, db });
    if (mode === 'fallback') {
      return { ...local, mode, model: null };
    }
    // 让模型看到最多 80 条真实计划（含 id），它才可能挑对要删/改的那一条
    const ctx = buildContext(db, { prefs: currentPrefs(), now, maxItems: 80 });
    const sys = [
      '你是本地时间规划引擎的解析器。把用户中文输入解析成结构化计划操作。',
      `今天是 ${today(now)}（${weekdayLabel(today(now))}），时区 Asia/Shanghai，全部用本地墙上时间。`,
      '可用 precision：year/quarter/month/week/day/slot/unscheduled。',
      '严格要求：',
      '1) 只说了年份/季度/月份/周，就分别用 year/quarter/month/week，并给出该区间第一天作为 startDate，绝不落到某一天某一刻；',
      '2) 只有用户明确说了日期与起止时刻才用 slot（startDate + startTime + endTime，HH:mm 24 小时制）；',
      '3) 时间说不清（如"两点到四点"没说是上午下午）时不要猜，放进 questions 反问，op 用 day 或 unscheduled；',
      '4) 只说"有空/以后/最近"就用 unscheduled，不推断日期；',
      '5) 只输出 JSON，格式：{"intent":"create|update|delete|query|plan","ops":[{"op":"create","item":{...}}],"questions":["..."],"confidence":0-1}；',
      '6) item 只包含 kind/title/notes/precision/startDate/endDate/startTime/endTime/dueDate/fuzzyLabel/priority/tags。',
      '7) 用户要删除/修改时，必须从下面的清单里挑真实的 id；绝不编造 id。',
      '8) 如果用户说的名字和清单里某条接近（少了空格、简称、同义），就用最接近的那条，不要反问。',
      '9) 拿不准是哪一条时，才把候选放进 questions。',
      '10) 判断意图：用户在说"已有计划"的推迟/提前/改时间/挪一下/取消/不做/删掉 → 一律 update 或 delete，'
        + '必须指向清单里最接近的那条，绝不新建；只有明确描述了一件清单里没有的新事，才 create。',
      '11) 不要说"我理解了/明白了"这类空话，直接给 JSON。',
      '示例（id 换成清单里的真实 id）：',
      '  用户说"那个论文的事往后推一周" → {"intent":"update","ops":[{"op":"update","id":"<论文那条 id>",'
        + '"patch":{"startDate":"<今天+7天>"}}],"questions":[],"confidence":0.8}',
      '  用户说"Q2 那个项目不做了" → {"intent":"delete","ops":[{"op":"delete","id":"<Q2 那条 id>"}],'
        + '"questions":[],"confidence":0.8}',
      `真实数据摘要（仅供参考，不要编造）：\n${contextText(ctx)}`,
    ].join('\n');
    const res = await callModel(
      [
        { role: 'system', content: sys },
        { role: 'user', content: String(text || '') },
      ],
      { json: true, maxTokens: 1200 },
    );
    if (!res.ok) {
      log('warn', `parse: model unavailable (${res.error || 'unknown'}), using local rules`);
      return { ...local, mode, model: null, degraded: true };
    }
    try {
      const data = res.data || {};
      const rejected = [];
      const ops = validateOps(Array.isArray(data.ops) ? data.ops : [], { tolerant: true, rejected });
      if (rejected.length) log('warn', `parse: ${rejected.length} op(s) rejected: ${rejected.slice(0, 2).join(' | ')}`);
      const confidence = Number(data.confidence);
      const questions = Array.isArray(data.questions) ? data.questions.filter((q) => typeof q === 'string') : [];
      // 模型在"时间本身有歧义"时仍给出 slot，说明它在猜：降级到本地保守结果
      if (local.confidence < 0.45 && ops.some((o) => o.op === 'create' && o.item.precision === 'slot')) {
        return { ...local, mode, model: AI_MODEL, degraded: true, questionNote: '模型试图猜精确时刻，已改用本地保守解析' };
      }
      // 模型优先：模型给的操作用模型给的。
      // 只有在"模型一个有效操作都没给、且规则层确实找到了操作"时，才用规则兜底。
      const modelIntent = typeof data.intent === 'string' ? data.intent : 'create';
      const localOps = Array.isArray(local.ops) ? local.ops : [];
      let finalOps = ops;
      let finalIntent = modelIntent;
      let usedFallbackOps = false;
      if (ops.length === 0 && localOps.length > 0) {
        finalOps = localOps;
        finalIntent = local.intent || modelIntent;
        usedFallbackOps = true;
        log('debug', 'parse: model gave no usable op, fell back to local parse');
      }

      let mergedQuestions = [];
      if (usedFallbackOps) {
        mergedQuestions = [...new Set(local.questions || [])];
      } else if (finalOps.length === 0) {
        mergedQuestions = [...new Set([...questions, ...(local.questions || [])])];
        // 删/改时只关心"改哪一条"，把时间追问排到后面
        if (finalIntent === 'delete' || finalIntent === 'update') {
          const targetQ = mergedQuestions.filter((q) => q.includes('哪一条') || q.includes('哪条') || q.includes('计划名称') || q.includes('要删'));
          const restQ = mergedQuestions.filter((q) => !targetQ.includes(q));
          mergedQuestions = [...targetQ, ...restQ];
        }
      }

      // 护栏：原话明显是在动"已有计划"，模型却给新建 —— 不能凭空造重复任务
      const MUTATION = /(推|挪|改期|改到|延后|提前|取消|不做|不要了|删|清掉)/;
      if (finalOps.length > 0 && finalOps.every((o) => o.op === 'create') && MUTATION.test(raw0)) {
        const guess = findItemByText(db, raw0);
        log('warn', `parse: model tried to create while user asked to modify (guess=${guess ? guess.title : 'none'})`);
        finalOps = [];
        mergedQuestions = [
          guess
            ? `你是想改动「${guess.title}」吗？说"删掉它"或给个新日期就行。`
            : `你想改动哪一条？现在有：${itemsForHint()}`,
        ];
        finalIntent = guess ? 'update' : 'delete';
      }

      return {
        intent: finalIntent,
        ops: finalOps,
        questions: mergedQuestions,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : local.confidence,
        parsed: local.parsed,
        mode,
        model: AI_MODEL,
      };
    } catch (err) {
      stats.failures += 1;
      stats.lastError = `invalid model output: ${err.message}`;
      log('warn', `deepseek parse output rejected, using fallback: ${err.message}`);
      return { ...local, mode, model: null, degraded: true };
    }
  }

  // -------------------------------------------------------------------------
  // /ai/create-from-text
  // -------------------------------------------------------------------------

  async function createFromText(text, { confirm = true, now = nowFn() } = {}) {
    const parsed = await parse(text, { now });
    const created = [];
    const skipped = [];
    const errors = [];
    if (confirm) {
      for (const op of parsed.ops) {
        try {
          if (op.op === 'create') {
            created.push(createItem(db, { ...op.item, source: 'ai' }, { source: 'ai', actorSource: 'ai' }));
          } else if (op.op === 'update') {
            const target = getItem(db, op.id);
            if (target && target.locked) {
              skipped.push({ id: op.id, reason: 'locked' });
              continue;
            }
            created.push(updateItem(db, op.id, op.patch || {}, { source: 'ai', actorSource: 'ai' }));
          } else if (op.op === 'delete') {
            const target = getItem(db, op.id);
            if (target && target.locked) {
              skipped.push({ id: op.id, reason: 'locked' });
              continue;
            }
            deleteItem(db, op.id, { source: 'ai' });
            created.push({ id: op.id, deleted: true });
          }
        } catch (err) {
          errors.push({ opIndex: parsed.ops.indexOf(op), id: op.id || null, reason: err.message });
        }
      }
    }
    return {
      intent: parsed.intent,
      created,
      skipped,
      errors,
      questions: parsed.questions,
      confidence: parsed.confidence,
      preview: parsed.ops,
      applied: confirm,
      mode: parsed.mode || mode,
      model: parsed.model || null,
    };
  }

  // -------------------------------------------------------------------------
  // /ai/plan
  // -------------------------------------------------------------------------

  function fallbackPlan({ days, from, now }) {
    const placement = proposePlacements(db, { days, from, prefs: currentPrefs(), now });
    const { ops, placed, window: win, candidates } = placement;
    const title = `未来 ${win.days} 天安排建议`;
    const lines = [];
    if (candidates === 0) {
      lines.push(`当前没有待安排的任务，未来 ${win.days} 天已排 ${win.totalMin} 分钟。`);
    } else {
      lines.push(
        `从 ${win.from} 起 ${win.days} 天，待安排池有 ${candidates} 项，我按截止近的优先排了 ${placed.length} 项。`,
      );
    }
    for (const p of placed) {
      lines.push(`- ${p.date} ${p.startTime}-${p.endTime} ${p.title}${p.dueDate ? `（截止 ${p.dueDate}）` : ''}`);
    }
    if (placed.length === 0) lines.push('- 没有找到合适的连续空档，建议先减少已有安排或缩短时长。');
    lines.push('这是一份 draft 建议，确认后才会写入计划。');
    return {
      title,
      summary: lines.join('\n'),
      ops,
      payload: { source: 'local-planner', placed, window: win },
    };
  }

  async function plan({ days = 5, from = null, now = nowFn() } = {}) {
    const prefs = currentPrefs();
    const n = Math.max(1, Math.min(14, Number(days) || prefs.fineWindowDays || 5));
    let draft = null;
    let planModelSummary = '';
    let planModelTitle = '';
    if (mode === 'api') {
      const ctx = buildContext(db, { days: n, prefs, now });
      const sys = [
        '你是桌面秘书的规划器。基于给定的真实数据，为接下来的日子安排任务。',
        '只输出 JSON：{"title":"...","summary":"...","ops":[...]}；ops 只能是 create/update/delete。',
        '规则：不要编造数据里不存在的事项；只能引用给定 id；每个 create 的 slot 任务必须给 startDate/startTime/endTime；',
        '不要改动 locked=1 的项；不要排 00:00-08:00；单日总时长不要超过 6 小时；',
        '摘要用中文，说明为什么这样排。',
        `今天是 ${today(now)}。真实数据：\n${contextText(ctx)}`,
      ].join('\n');
      const res = await callModel(
        [
          { role: 'system', content: sys },
          { role: 'user', content: `请给出未来 ${n} 天的安排建议。` },
        ],
        { json: true, maxTokens: 2000 },
      );
      if (res.ok) {
        try {
          const data = res.data || {};
          const rejectedOps = [];
          const ops = validateOps(Array.isArray(data.ops) ? data.ops : [], { tolerant: true, rejected: rejectedOps });
          planModelSummary = typeof data.summary === 'string' ? data.summary.slice(0, 4000) : '';
          planModelTitle = typeof data.title === 'string' && data.title ? data.title.slice(0, 120) : '';
          if (rejectedOps.length) log('warn', `plan: ${rejectedOps.length} op(s) rejected: ${rejectedOps.slice(0, 2).join(' | ')}`);
          log('debug', `plan: model ops=${ops.length} summaryLen=${planModelSummary.length}`);
          if (ops.length > 0) {
            draft = {
              title: typeof data.title === 'string' && data.title ? data.title.slice(0, 120) : `未来 ${n} 天安排建议`,
              summary: typeof data.summary === 'string' ? data.summary.slice(0, 4000) : '',
              ops,
              payload: { source: 'deepseek', model: AI_MODEL },
            };
          }
        } catch (err) {
          stats.failures += 1;
          stats.lastError = `invalid plan output: ${err.message}`;
          log('warn', `deepseek plan rejected, using fallback: ${err.message}`);
        }
      }
    }
    const local = fallbackPlan({ days: n, from, now });
    if (!draft && planModelSummary) {
      // 模型给了分析但没有可用的 ops：保留它的摘要，用本地确定性算法排时间
      draft = {
        title: planModelTitle || local.title,
        summary: `${planModelSummary}\n\n（具体时段由本地算法按真实空档排布，未使用模型给的时间）`,
        ops: local.ops,
        payload: { source: 'deepseek-summary', model: AI_MODEL, placed: local.payload.placed, window: local.payload.window },
      };
      log('warn', 'plan: model returned no usable ops, kept its summary + local placement');
    }
    if (!draft) draft = local;
    const proposal = createProposal(db, { ...draft, kind: 'plan' }, { source: 'ai' });
    return {
      proposal,
      mode: draft.payload && ['deepseek', 'deepseek-summary'].includes(draft.payload.source) ? 'api' : 'fallback',
      model: draft.payload && draft.payload.source === 'deepseek' ? AI_MODEL : null,
    };
  }

  // -------------------------------------------------------------------------
  // /ai/analyze
  // -------------------------------------------------------------------------

  async function analyze({ scope = '5d', now = nowFn() } = {}) {
    const prefs = currentPrefs();
    const days = scope === '30d' ? 30 : scope === 'all' ? 14 : Number(prefs.fineWindowDays) || 5;
    const conflicts = computeConflicts(db, { now, prefs });
    const ctx = buildContext(db, { days, prefs, now });
    const findings = conflicts.map((c) => ({
      id: c.id,
      type: c.type,
      severity: c.severity,
      itemIds: c.itemIds,
      message: c.message,
      suggestion: c.suggestion,
    }));

    let summary;
    let usedMode = 'fallback';
    if (mode === 'api') {
      const sys = [
        '你是桌面 AI 秘书，用中文简要分析用户的计划风险。',
        '只能基于下面给出的真实检测结果与数据摘要，不要编造任何计划项、日期或数字。',
        '输出 JSON：{"summary":"..."}，summary 控制在 200 字以内，先讲最严重的，再给一条可执行建议。',
        `数据摘要：\n${contextText(ctx)}\n检测结果：\n${JSON.stringify(findings, null, 2)}`,
      ].join('\n');
      const res = await callModel(
        [
          { role: 'system', content: sys },
          { role: 'user', content: `请分析 scope=${scope} 的风险。` },
        ],
        { json: true, maxTokens: 800 },
      );
      if (res.ok && res.data && typeof res.data.summary === 'string') {
        summary = res.data.summary;
        usedMode = 'api';
      }
    }
    if (!summary) {
      const high = findings.filter((f) => f.severity === 'high').length;
      const lines = [];
      if (findings.length === 0) {
        lines.push(`未来 ${days} 天没有检测到冲突：${ctx.window.totalMin} 分钟安排，${ctx.window.busyDays} 天有空档。`);
        if (ctx.counts.unscheduled > 0) {
          lines.push(`不过还有 ${ctx.counts.unscheduled} 项待安排，可以考虑放进空档。`);
        }
      } else {
        lines.push(`共 ${findings.length} 条风险，其中 ${high} 条需要优先处理。`);
        for (const f of findings.slice(0, 5)) lines.push(`- ${f.message}。建议：${f.suggestion}`);
      }
      summary = lines.join('\n');
    }

    return {
      scope,
      days,
      mode: usedMode,
      summary,
      findings,
      stats: {
        conflicts: findings.length,
        byType: findings.reduce((acc, f) => {
          acc[f.type] = (acc[f.type] || 0) + 1;
          return acc;
        }, {}),
        totalMin: ctx.window.totalMin,
        unscheduled: ctx.counts.unscheduled,
      },
    };
  }

  // -------------------------------------------------------------------------
  // /ai/simulate —— 纯本地计算
  // -------------------------------------------------------------------------

  function simulateScenario({ scenario = '', options = {}, days = 5, from = null, now = nowFn() } = {}) {
    const result = simulate(db, {
      scenario,
      options,
      days,
      from,
      prefs: currentPrefs(),
      now,
    });
    return { ...result, mode: 'fallback', note: '情景推演为本地确定性计算，不修改任何数据' };
  }

  // -------------------------------------------------------------------------
  // /ai/chat
  // -------------------------------------------------------------------------

  async function chat({ text = '', context = null, now = nowFn() } = {}) {
    const prefs = currentPrefs();
    const ctx = buildContext(db, { days: Number(prefs.fineWindowDays) || 5, prefs, now });
    const usedItems = ctx.items.length;
    if (mode === 'api') {
      const sys = [
        '你是用户的桌面 AI 秘书，说话简洁、具体、像真人。',
        '只能基于下面提供的真实计划摘要回答；摘要里没有的，就说不知道并建议用户先规划。禁止编造计划项、数字或完成情况。',
        '不要使用 Markdown 标题，不要输出代码块。',
        `真实数据摘要：\n${contextText(ctx)}`,
      ].join('\n');
      const messages = [{ role: 'system', content: sys }];
      if (context && typeof context === 'object') {
        messages.push({ role: 'system', content: `调用方补充上下文：${JSON.stringify(context).slice(0, 800)}` });
      }
      messages.push({ role: 'user', content: String(text || '') });
      const res = await callModel(messages, { json: false, maxTokens: 600 });
      if (res.ok) {
        return { reply: String(res.content).trim(), mode: 'api', model: AI_MODEL, usedContext: { items: usedItems } };
      }
    }
    // 确定性兜底：只复述真实数字
    const lines = [];
    const t = String(text || '');
    if (/(冲突|风险|问题|紧张|忙不忙|来得及)/.test(t)) {
      const conflicts = computeConflicts(db, { now, prefs });
      if (conflicts.length === 0) lines.push('我扫了一遍，暂时没有冲突。');
      else {
        lines.push(`现在有 ${conflicts.length} 条风险：`);
        for (const c of conflicts.slice(0, 3)) lines.push(`· ${c.message}`);
      }
    } else if (/(待安排|没排|未安排|池)/.test(t)) {
      const pool = unscheduledCandidates(db, { days: 5, now });
      lines.push(
        pool.length
          ? `待安排池里有 ${pool.length} 项，最近的是「${pool[0].item.title}」。要我用 /ai/plan 排一下吗？`
          : '待安排池是空的，所有任务都有时间了。',
      );
    } else if (/(今天|明天|这周|安排|计划|日程|忙)/.test(t)) {
      lines.push(`${ctx.window.from} 到 ${ctx.window.to} 一共排了 ${ctx.window.totalMin} 分钟，${ctx.window.busyDays} 天有安排。`);
      const d = ctx.windowDays.find((x) => x.items.length > 0);
      if (d) {
        lines.push(
          `${d.date}（${d.weekday}）：` +
            d.items.map((i) => `${i.title}${i.startTime ? ` ${i.startTime}-${i.endTime}` : ''}`).join('；'),
        );
      } else {
        lines.push('这几天还没有具体日程，可以从待安排池里挑一件先排上。');
      }
      if (ctx.counts.unscheduled > 0) lines.push(`另外还有 ${ctx.counts.unscheduled} 项待安排。`);
    } else if (/(目标|长期|进度)/.test(t)) {
      if (ctx.goals.length === 0) lines.push('还没有登记长期目标。');
      else {
        lines.push('长期目标进度：');
        for (const g of ctx.goals.slice(0, 5)) lines.push(`· ${g.title}（${g.interval}）${g.progress}%`);
      }
    } else {
      lines.push(`我看到 ${ctx.counts.active} 项未完成计划，未来 ${ctx.window.days} 天排了 ${ctx.window.totalMin} 分钟。`);
      lines.push('你可以问我“今天安排得怎么样”“有什么风险”，或者让我为待安排的任务找时间。');
    }
    return { reply: lines.join('\n'), mode: 'fallback', model: null, usedContext: { items: usedItems } };
  }

  return {
    mode,
    status: apiStatus,
    parse,
    createFromText,
    plan,
    analyze,
    simulate: simulateScenario,
    chat,
    buildContext: (opts) => buildContext(db, { prefs: currentPrefs(), ...opts }),
    contextText,
  };
}
