// 中文自然语言 -> 结构化 ops（确定性规则，零依赖）。
//
// 设计原则（契约 §2.4）：
//  - 拿不准就放进 questions 反问，绝不猜一个精确时刻；
//  - 明确到"年/季度/月/周"就产出对应 precision 的区间，绝不落到某一天；
//  - 只有用户明确说出日期 + 起止时刻，才产出 precision='slot'。
import {
  addDays,
  expandPrecision,
  monthRange,
  quarterLabel,
  quarterRange,
  startOfWeekMonday,
  today,
  weekdayIndex,
  yearRange,
} from './time.mjs';
import { all } from './db.mjs';

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const WEEKDAY_CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 七: 7 };
const PERIODS = ['凌晨', '早上', '早晨', '上午', '中午', '下午', '傍晚', '晚上', '夜里', '半夜'];

export function cnNumber(s) {
  if (s === null || s === undefined) return NaN;
  const str = String(s).trim();
  if (!str) return NaN;
  if (/^\d+$/.test(str)) return Number(str);
  if (str === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(str)) return 10 + CN_DIGITS[str[1]];
  if (/^[一二三四五六七八九]十$/.test(str)) return CN_DIGITS[str[0]] * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(str)) {
    return CN_DIGITS[str[0]] * 10 + CN_DIGITS[str[2]];
  }
  if (str.length === 1 && str in CN_DIGITS) return CN_DIGITS[str];
  return NaN;
}

// 只用于"按名字找计划"：去掉所有空白与常见标点，全角转半角，忽略大小写
function normalizeTitle(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''（）()《》【】\[\]{}·•—\-–_/\\|,.:;!?'"`~]/g, '')
    .toLowerCase()
    .trim();
}

function normalizeText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\u3000/g, ' ')
    .trim();
}

function applyPeriod(hour, period, { isEnd = false } = {}) {
  if (!period) return hour;
  switch (period) {
    case '凌晨':
    case '半夜':
      return hour === 12 ? 0 : hour;
    case '早上':
    case '早晨':
    case '上午':
      return hour;
    case '中午':
      return hour < 11 ? hour + 12 : hour;
    case '下午':
    case '傍晚':
      return hour < 12 ? hour + 12 : hour;
    case '晚上':
    case '夜里':
      if (hour === 12) return 12;
      return hour < 12 ? hour + 12 : hour;
    default:
      return hour;
  }
}

function parseTimeToken(token) {
  const re =
    /^(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|半夜)?\s*(\d{1,3}|[一二三四五六七八九十两]{1,3})\s*(?:点|时|[:：])\s*(半|\d{1,2}|[一二三四五六七八九十两]{1,3})?\s*分?$/;
  const m = re.exec(token.trim());
  if (!m) return null;
  const period = m[1] || null;
  const hourNum = cnNumber(m[2]);
  if (!Number.isFinite(hourNum) || hourNum > 24) return null;
  let minute = 0;
  if (m[3] === '半') minute = 30;
  else if (m[3]) {
    const v = cnNumber(m[3]);
    if (!Number.isFinite(v) || v > 59) return null;
    minute = v;
  }
  const hasColon = /[:：]/.test(token);
  let hour = hourNum;
  if (!hasColon) hour = applyPeriod(hourNum, period);
  else if (period) hour = applyPeriod(hourNum, period);
  if (hour > 23) return null;
  return { period, hour, minute, total: hour * 60 + minute, hasColon };
}

const TIME_TOKEN =
  '(?:(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|半夜)\\s*)?(\\d{1,3}|[一二三四五六七八九十两]{1,3})\\s*(?:点|时|[:：])\\s*(半|\\d{1,2}|[一二三四五六七八九十两]{1,3})?\\s*分?';
const RANGE_RE = new RegExp(
  `${TIME_TOKEN}\\s*(?:到|至|~|～|—|–|-)\\s*${TIME_TOKEN}`,
);
const SINGLE_RE = new RegExp(TIME_TOKEN);
const PERIOD_ONLY_RE = new RegExp(`^(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|半夜)`);

function extractTimeRange(work) {
  const rm = RANGE_RE.exec(work);
  if (rm) {
    const startToken = rm[0].slice(0, rm[0].search(/\s*(?:到|至|~|～|—|–|-)\s*/));
    const sepMatch = /\s*(?:到|至|~|～|—|–|-)\s*/.exec(rm[0]);
    const endToken = rm[0].slice(sepMatch.index + sepMatch[0].length);
    const start = parseTimeToken(startToken);
    const end = parseTimeToken(endToken);
    if (start && end) {
      const ambiguous = !start.period && !start.hasColon && start.hour <= 12;
      let endTotal = end.total;
      if (!end.period && !end.hasColon && start.period) {
        // 下午两点到四点：终点继承起点时段
        const adjusted = end.hour + (start.hour >= 12 && end.hour < 12 ? 12 : 0);
        endTotal = adjusted * 60 + end.minute;
      }
      let endHour = Math.floor(endTotal / 60);
      let endMinute = endTotal % 60;
      if (endTotal <= start.total) {
        if (start.period && endTotal + 12 * 60 > start.total) {
          endTotal += 12 * 60;
          endHour = Math.floor(endTotal / 60);
          endMinute = endTotal % 60;
        } else {
          return { ambiguous: true, reason: 'end-before-start', raw: rm[0], rest: work.replace(rm[0], ' ') };
        }
      }
      if (endHour > 23) {
        return { ambiguous: true, reason: 'cross-midnight', raw: rm[0], rest: work.replace(rm[0], ' ') };
      }
      return {
        ambiguous: ambiguous || !start.period && !start.hasColon && !end.hasColon,
        startTime: `${String(start.hour).padStart(2, '0')}:${String(start.minute).padStart(2, '0')}`,
        endTime: `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`,
        raw: rm[0],
        rest: work.replace(rm[0], ' '),
      };
    }
  }
  const sm = SINGLE_RE.exec(work);
  if (sm) {
    const token = sm[0];
    const t = parseTimeToken(token);
    if (t) {
      return {
        ambiguous: true,
        reason: 'no-end',
        raw: token,
        rest: work.replace(token, ' '),
        startTimeOnly: `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`,
      };
    }
  }
  return null;
}

function inferYearForMonth(month, now) {
  const nowMonth = now.getMonth() + 1;
  const nowYear = now.getFullYear();
  if (month < nowMonth) return { year: nowYear + 1, inferred: true };
  return { year: nowYear, inferred: false };
}

function nextWeekday(nowDate, target, { nextWeek = false } = {}) {
  const todayStr = today(nowDate);
  const current = weekdayIndex(todayStr); // 0=周一
  const targetIdx = target - 1;
  let delta;
  if (nextWeek) {
    const toNextMonday = 7 - current;
    delta = toNextMonday + targetIdx;
  } else {
    delta = (targetIdx - current + 7) % 7;
  }
  return addDays(todayStr, delta);
}

/**
 * 解析中文文本。
 * @returns {{intent:string, ops:Array, questions:string[], confidence:number, parsed:object}}
 */
export function parseText(text, { now = new Date(), db = null } = {}) {
  const original = String(text || '');
  let work = normalizeText(original);
  const questions = [];
  const removed = [];

  const state = {
    year: null,
    yearInferred: false,
    month: null,
    day: null,
    quarter: null,
    weekStart: null,
    explicitYear: false,
    explicitMonth: false,
    explicitDay: false,
    repeat: null,
    repeatWeekday: null,
    repeatMonthDay: null,
    fuzzyLabel: null,
    vague: false,
  };

  const take = (re, handler) => {
    const m = re.exec(work);
    if (!m) return null;
    const consumed = m[0];
    removed.push(consumed);
    work = work.replace(consumed, ' ');
    return handler(m);
  };

  // ---- 明确的年月日 ----
  take(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/, (m) => {
    state.year = Number(m[1]);
    state.month = Number(m[2]);
    state.day = Number(m[3]);
    state.explicitYear = true;
    state.explicitMonth = true;
    state.explicitDay = true;
    return true;
  });
  if (!state.day) {
    take(/(\d{4})\s*年\s*(\d{1,2})\s*月/, (m) => {
      state.year = Number(m[1]);
      state.month = Number(m[2]);
      state.explicitYear = true;
      state.explicitMonth = true;
      return true;
    });
  }
  if (!state.year) {
    take(/(\d{4})\s*年/, (m) => {
      state.year = Number(m[1]);
      state.explicitYear = true;
      return true;
    });
  }
  // ---- 相对年 ----
  if (!state.year) {
    take(/后年/, () => {
      state.year = now.getFullYear() + 2;
      state.explicitYear = true;
      return true;
    });
  }
  if (!state.year) {
    take(/明年/, () => {
      state.year = now.getFullYear() + 1;
      state.explicitYear = true;
      return true;
    });
  }
  if (!state.year) {
    take(/(今年|本年)/, () => {
      state.year = now.getFullYear();
      state.explicitYear = true;
      return true;
    });
  }
  // ---- 季度 ----
  take(/第\s*([一二三四1-4])\s*季度/, (m) => {
    state.quarter = cnNumber(m[1]);
    return true;
  });
  if (!state.quarter) {
    take(/Q\s*([1-4])/i, (m) => {
      state.quarter = Number(m[1]);
      return true;
    });
  }
  // ---- 月 / 日 ----
  if (!state.month) {
    take(/(\d{1,2})\s*月份?/, (m) => {
      state.month = Number(m[1]);
      state.explicitMonth = true;
      return true;
    });
  }
  if (!state.month) {
    take(/(十[一二]?|[一二三四五六七八九])\s*月份?/, (m) => {
      const v = cnNumber(m[1]);
      state.month = v;
      state.explicitMonth = true;
      state.fuzzyLabel = m[0];
      return true;
    });
  }
  if (!state.day && state.month) {
    take(/(\d{1,2})\s*[日号]/, (m) => {
      state.day = Number(m[1]);
      state.explicitDay = true;
      return true;
    });
  }
  if (!state.day && state.month) {
    take(/([一二三四五六七八九十]{1,3})\s*[日号]/, (m) => {
      const v = cnNumber(m[1]);
      if (Number.isFinite(v) && v >= 1 && v <= 31) {
        state.day = v;
        state.explicitDay = true;
        return true;
      }
      return false;
    });
  }
  take(/(上旬|中旬|下旬)/, (m) => {
    state.fuzzyLabel = `${state.month ? `${state.month}月` : ''}${m[1]}`;
    if (!state.month) state.month = now.getMonth() + 1;
    return true;
  });
  take(/(月底|月末|月初)/, (m) => {
    state.fuzzyLabel = m[1];
    if (!state.month) {
      state.month = now.getMonth() + 1;
      state.explicitMonth = true;
    }
    const range = monthRange(state.year || now.getFullYear(), state.month);
    if (m[1] === '月初') state.day = 1;
    else state.day = Number(range.endDate.slice(8, 10));
    state.explicitDay = true;
    return true;
  });

  // ---- 相对日 ----
  take(/大后天/, () => {
    state.day = Number(addDays(today(now), 3).slice(8, 10));
    state.month = Number(addDays(today(now), 3).slice(5, 7));
    state.year = Number(addDays(today(now), 3).slice(0, 4));
    state.explicitDay = true;
    return true;
  });
  if (!state.day) {
    take(/后天/, () => {
      const d = addDays(today(now), 2);
      state.year = Number(d.slice(0, 4));
      state.month = Number(d.slice(5, 7));
      state.day = Number(d.slice(8, 10));
      state.explicitDay = true;
      return true;
    });
  }
  if (!state.day) {
    take(/明天|明日/, () => {
      const d = addDays(today(now), 1);
      state.year = Number(d.slice(0, 4));
      state.month = Number(d.slice(5, 7));
      state.day = Number(d.slice(8, 10));
      state.explicitDay = true;
      return true;
    });
  }
  if (!state.day) {
    take(/今天|今日/, () => {
      const d = today(now);
      state.year = Number(d.slice(0, 4));
      state.month = Number(d.slice(5, 7));
      state.day = Number(d.slice(8, 10));
      state.explicitDay = true;
      return true;
    });
  }

  // ---- 重复（必须早于"周X"，否则"每周三"会被当成下周三） ----
  take(/(每天|每日|天天)/, () => {
    state.repeat = 'daily';
    return true;
  });
  if (!state.repeat) {
    take(/每(?:周|星期|礼拜)([一二三四五六日天])?/, (m) => {
      state.repeat = 'weekly';
      if (m[1]) state.repeatWeekday = WEEKDAY_CN[m[1]];
      return true;
    });
  }
  if (!state.repeat) {
    take(/每月\s*(\d{1,2})?\s*[日号]?/, (m) => {
      state.repeat = 'monthly';
      if (m[1]) state.repeatMonthDay = Number(m[1]);
      return true;
    });
  }

  // ---- 周 ----
  take(/(下周|下星期|下礼拜)([一二三四五六日天])?/, (m) => {
    if (m[2]) {
      state.fuzzyLabel = `${m[1]}${m[2]}`;
      const target = WEEKDAY_CN[m[2]];
      const d = nextWeekday(now, target, { nextWeek: true });
      state.year = Number(d.slice(0, 4));
      state.month = Number(d.slice(5, 7));
      state.day = Number(d.slice(8, 10));
      state.explicitDay = true;
    } else {
      const d = startOfWeekMonday(addDays(today(now), 7));
      state.weekStart = d;
      state.fuzzyLabel = '下周';
    }
    return true;
  });
  if (!state.day) {
    take(/(这周|本周|这星期|这个星期)/, () => {
      state.weekStart = startOfWeekMonday(today(now));
      state.fuzzyLabel = '本周';
      return true;
    });
  }
  if (!state.day) {
    take(/(?:周|星期|礼拜)([一二三四五六日天])/, (m) => {
      const target = WEEKDAY_CN[m[1]];
      const d = nextWeekday(now, target);
      state.year = Number(d.slice(0, 4));
      state.month = Number(d.slice(5, 7));
      state.day = Number(d.slice(8, 10));
      state.explicitDay = true;
      state.fuzzyLabel = `周${m[1]}`;
      return true;
    });
  }
  if (!state.day) {
    take(/(下个月|下月)/, () => {
      const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      state.year = d.getFullYear();
      state.month = d.getMonth() + 1;
      state.explicitMonth = true;
      return true;
    });
  }

  // ---- 时间 ----
  const timeInfo = extractTimeRange(work);
  let startTime = null;
  let endTime = null;
  let ambiguousTime = false;
  if (timeInfo) {
    work = timeInfo.rest;
    removed.push(timeInfo.raw);
    if (timeInfo.ambiguous) {
      ambiguousTime = true;
      if (timeInfo.reason === 'no-end') {
        questions.push(`「${timeInfo.raw}」需要多长时间？给我一个起止时间（例如 ${timeInfo.startTimeOnly}-${addHour(timeInfo.startTimeOnly)}）。`);
      } else if (timeInfo.reason === 'end-before-start' || timeInfo.reason === 'cross-midnight') {
        questions.push(`「${timeInfo.raw}」的结束时间不明确，能说成具体几点到几点吗？`);
      } else {
        questions.push(`「${timeInfo.raw}」是上午还是下午？确认后我再排。`);
      }
    } else {
      startTime = timeInfo.startTime;
      endTime = timeInfo.endTime;
    }
  }

  // ---- 模糊词 ----
  if (/(有空|找时间|有时间|改天|之后|以后|回头|最近|这段时间|抽空|看情况)/.test(work)) {
    state.vague = true;
    work = work.replace(/(有空|找时间|有时间|改天|之后|以后|回头|最近|这段时间|抽空|看情况)(的时候)?/g, ' ');
  }

  // ---- 补全日期 ----
  let year = state.year;
  if (!year && state.month) {
    const infer = inferYearForMonth(state.month, now);
    year = infer.year;
    state.yearInferred = infer.inferred;
    if (infer.inferred) {
      questions.push(`「${state.month}月」我按 ${year} 年理解（今年这个月已经过了），对吗？`);
    }
  }
  if (!year && state.quarter) {
    const y = now.getFullYear();
    if (quarterRange(y, state.quarter).endDate < today(now)) {
      year = y + 1;
      state.yearInferred = true;
      questions.push(`第 ${state.quarter} 季度今年已经过了，我按 ${year} 年理解，对吗？`);
    } else {
      year = y;
    }
  }
  if (state.quarter && state.month) {
    // 同时给了季度和月份：以月为准，忽略季度
    state.quarter = null;
  }

  let baseDate = null;
  if (state.day && state.month && year) {
    if (state.day > 28) {
      const range = monthRange(year, state.month);
      const maxDay = Number(range.endDate.slice(8, 10));
      if (state.day > maxDay) state.day = maxDay;
    }
    baseDate = `${year}-${String(state.month).padStart(2, '0')}-${String(state.day).padStart(2, '0')}`;
  } else if (state.weekStart) {
    baseDate = state.weekStart;
  } else if (state.month && year) {
    baseDate = monthRange(year, state.month).startDate;
  } else if (state.quarter && year) {
    baseDate = quarterRange(year, state.quarter).startDate;
  } else if (year) {
    baseDate = yearRange(year).startDate;
  }

  // 重复任务的下一次发生日
  if (state.repeat) {
    if (state.repeat === 'daily' && !baseDate) {
      baseDate = addDays(today(now), 1);
      state.explicitDay = true;
    } else if (state.repeat === 'weekly') {
      const target = state.repeatWeekday || 1;
      baseDate = nextWeekday(now, target);
      state.explicitDay = true;
    } else if (state.repeat === 'monthly') {
      const dom = state.repeatMonthDay || now.getDate();
      const d = new Date(now.getFullYear(), now.getMonth() + 1, dom);
      state.year = d.getFullYear();
      baseDate = `${state.year}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      state.explicitDay = true;
    }
  }

  // ---- 决定 precision ----
  let precision;
  if (startTime && endTime) precision = 'slot';
  else if (state.day || state.explicitDay) precision = 'day';
  else if (state.repeat === 'weekly' || state.repeat === 'monthly' || state.repeat === 'daily') {
    precision = 'day';
  } else if (state.weekStart) precision = 'week';
  else if (state.quarter) precision = 'quarter';
  else if (state.month) precision = 'month';
  else if (year) precision = 'year';
  else precision = 'unscheduled';

  if (precision === 'slot' && !baseDate) {
    precision = 'unscheduled';
    questions.push('这条还没说具体哪一天，我先放进待安排池，好吗？');
  }
  if (precision === 'day' && !baseDate) {
    precision = 'unscheduled';
  }
  if (precision === 'year' && !baseDate) precision = 'unscheduled';

  // 没有任何时间信息
  if (precision === 'unscheduled' && !state.vague) {
    questions.push('想安排在什么时候？可以直接说“2027 年”“下周三”或“明天下午两点到四点”。');
  } else if (precision === 'unscheduled' && state.vague) {
    questions.push('这条先放进待安排池，等你确定具体时间再排，可以吗？');
  }
  if (state.repeat && !startTime) {
    const label = state.repeat === 'daily' ? '每天' : state.repeat === 'weekly' ? '每周' : '每月';
    questions.push(`重复规则是“${label}”，具体几点做、做多久？`);
  }

  // ---- 标题 ----
  const title = extractTitle(work, original, precision);

  // ---- kind ----
  let kind = 'task';
  if (/(里程碑|节点|milestone)/.test(original)) kind = 'milestone';
  else if (/(目标|goal)/i.test(original)) kind = 'goal';
  else if (precision === 'slot' || precision === 'day') kind = 'task';
  else if (/(项目|产品|project)/i.test(original)) kind = 'project';
  else if (precision === 'year') kind = 'goal';
  else if (precision === 'quarter') kind = 'project';
  else if (precision === 'month') kind = 'project';
  else if (precision === 'week') kind = 'phase';
  else kind = 'task';

  // ---- 区间 ----
  let interval = { startDate: null, endDate: null, startTime: null, endTime: null };
  if (precision !== 'unscheduled' && baseDate) {
    interval = expandPrecision(precision, baseDate, { startTime, endTime });
  }

  const tags = [];
  if (state.repeat === 'daily') tags.push('repeat:daily');
  if (state.repeat === 'weekly') tags.push('repeat:weekly');
  if (state.repeat === 'monthly') tags.push('repeat:monthly');
  if (state.vague) tags.push('needs-scheduling');

  const notes = [];
  if (state.repeat) notes.push(`重复：${state.repeat === 'daily' ? '每天' : state.repeat === 'weekly' ? '每周' : '每月'}`);
  if (state.repeat) {
    notes.push('（v1 数据模型没有 recurrence 字段，重复规则记录在 tags/notes 里）');
  }

  const item = {
    kind,
    title,
    precision,
    startDate: interval.startDate,
    endDate: interval.endDate,
    startTime: interval.startTime,
    endTime: interval.endTime,
    fuzzyLabel: state.fuzzyLabel || null,
    notes: notes.join('\n'),
    tags,
    source: 'ai',
  };
  if (precision === 'quarter') item.fuzzyLabel = item.fuzzyLabel || quarterLabel(interval.startDate);
  if (precision === 'year') item.fuzzyLabel = item.fuzzyLabel || `${interval.startDate.slice(0, 4)} 年`;

  // ---- intent ----
  let intent = 'create';
  if (/(删除|删掉|取消|去掉)/.test(original) && !/取消提醒/.test(original)) intent = 'delete';
  else if (/(推迟|提前|挪到|改到|调整|顺延)/.test(original)) intent = 'update';
  else if (/(规划|怎么安排|安排一下|计划一下|帮我排|重新排)/.test(original)) intent = 'plan';
  else if (/(有什么|查看|看看|多少|查询|还有哪些)/.test(original) && !/(我想|我要|打算|帮我建)/.test(original)) intent = 'query';

  let ops = [];
  if (intent === 'create' || intent === 'plan') {
    ops = [{ op: 'create', item }];
  } else if ((intent === 'update' || intent === 'delete') && db) {
    const target = findItemByText(db, original);
    if (target) {
      if (intent === 'delete') ops = [{ op: 'delete', id: target.id }];
      else {
        const patch = {};
        if (precision === 'slot' && interval.startDate) {
          patch.precision = 'slot';
          patch.startDate = interval.startDate;
          patch.startTime = interval.startTime;
          patch.endTime = interval.endTime;
        } else if (precision !== 'unscheduled' && interval.startDate) {
          patch.precision = precision;
          patch.startDate = interval.startDate;
        }
        ops = [{ op: 'update', id: target.id, patch }];
      }
    } else {
      const names = all(
        db,
        "SELECT title FROM items WHERE status NOT IN ('done','cancelled') ORDER BY updatedAt DESC LIMIT 8",
      ).map((r) => String(r.title || '')).filter(Boolean);
      const action = intent === 'delete' ? '删' : '修改';
      questions.push(
        names.length
          ? `要${action}哪一条？现在有：${names.join('、')}。直接说名字就行。`
          : `现在没有可以${action}的计划。`,
      );
    }
  } else if (intent === 'update' || intent === 'delete') {
    questions.push('要改哪一条？请给出计划名称。');
  }

  // 删除/修改意图下，只保留"要改哪一条"这类问题；
  // 否则"删掉 Q2 完成产品原型"会被当成"你说的是哪一年第 2 季度"。
  if (intent === 'delete' || intent === 'update') {
    if (ops.length > 0) {
      questions.length = 0;
    } else {
      const targetQs = questions.filter((q) => q.includes('哪一条') || q.includes('哪条') || q.includes('要删') || q.includes('要修改'));
      questions.length = 0;
      questions.push(...targetQs);
    }
  }

  // ---- confidence ----
  let confidence;
  if (intent === 'query') confidence = 0.6;
  else if (startTime && endTime && baseDate) confidence = state.yearInferred ? 0.82 : 0.92;
  else if (precision === 'year' || precision === 'quarter' || precision === 'month') confidence = 0.85;
  else if (precision === 'day' || precision === 'week') confidence = 0.8;
  else if (state.repeat) confidence = 0.65;
  else confidence = 0.35;
  if (ambiguousTime) confidence = Math.min(confidence, 0.4);
  if (state.vague) confidence = Math.min(confidence, 0.35);

  return {
    intent,
    ops,
    questions: [...new Set(questions)],
    confidence,
    parsed: {
      precision,
      startDate: interval.startDate,
      endDate: interval.endDate,
      startTime: interval.startTime,
      endTime: interval.endTime,
      fuzzyLabel: item.fuzzyLabel,
      repeat: state.repeat,
      ambiguousTime,
      yearInferred: state.yearInferred,
      raw: original,
      normalized: normalizeText(original),
    },
  };
}

function addHour(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const TITLE_FILLERS = [
  /^(我|我们)\s*(想要|想|要|打算|计划|准备|希望|需要|得)/,
  /^(帮我|帮忙|请|麻烦|劳驾|给我|替我)/,
  /^(想要|想|要|打算|计划|准备|希望|需要)/,
  /^(安排|规划|计划|记一下|记录|添加|新增|建一个|建立|创建)/,
  /^(把|将|在)/,
  /^(系统地|认真|好好|尽量|抽空|开始|继续|尽快)/,
  /^(一下|一个|一条|个)/,
];

function extractTitle(work, original, precision) {
  let t = work.trim();
  for (const re of TITLE_FILLERS) {
    let prev;
    do {
      prev = t;
      t = t.replace(re, '');
    } while (t !== prev);
  }
  t = t
    .replace(/[，。！？；、,.!?;:：]/g, ' ')
    .replace(/^(的|了|吧|呢|啊|呀|哦)+/, '')
    .replace(/(吧|呢|啊|呀|哦|了)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) {
    const fallback = {
      year: '年度目标',
      quarter: '季度计划',
      month: '月度计划',
      week: '本周计划',
      day: '当日任务',
      slot: '待办任务',
      unscheduled: '待安排任务',
    };
    t = fallback[precision] || '待办任务';
  }
  return t.slice(0, 120);
}

/** 在现有 items 里按标题子串找最匹配的一条（update/delete 用） */
export function findItemByText(db, text) {
  if (!db) return null;
  const rows = all(db, "SELECT id, title FROM items WHERE status NOT IN ('done','cancelled')");
  const normalized = normalizeTitle(text);
  if (!normalized) return null;
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const title = normalizeTitle(row.title);
    if (!title) continue;
    let score = 0;
    if (normalized.includes(title)) {
      // 用户原话里出现了完整标题（越长的标题越可信）
      score = title.length + 100;
    } else if (title.includes(normalized) && normalized.length >= 2) {
      // 用户只说了标题的一部分（如"产品原型"）
      score = normalized.length;
    }
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

/** 供 /ai/parse 的 fallback 使用：解析 + 把 ops 里的 item 补全（不写库） */
export function parseToOps(text, { now = new Date(), db = null } = {}) {
  const result = parseText(text, { now, db });
  return result;
}
