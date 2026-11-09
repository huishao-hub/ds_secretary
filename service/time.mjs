// 本地墙上时间工具。
// 约定（见 docs/API.md §0）：日期 YYYY-MM-DD、时刻 HH:mm、时间戳 YYYY-MM-DDTHH:mm:ss，
// 全部按运行机器的本地墙上时间处理，不做 UTC 换算、不把模糊计划折成某一瞬间。
//
// 实现备注：纯日期运算用 UTC 毫秒做算术（Date.UTC），只取 UTC 年月日字段，
// 这样即使机器时区带 DST 也不会因为 23/25 小时的日子算错日期；"现在"和
// 时刻比较仍用本地 Date。Asia/Shanghai 无 DST，但代码不依赖这一点。

export const TZ = 'Asia/Shanghai';
const MS_PER_DAY = 86400000;

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地 Date -> YYYY-MM-DD */
export function fmtDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地 Date -> HH:mm */
export function fmtTime(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 本地 Date -> YYYY-MM-DDTHH:mm:ss（不带时区偏移，契约要求） */
export function fmtStamp(d) {
  return `${fmtDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function nowDate() {
  return new Date();
}

export function today(now = new Date()) {
  return fmtDate(now);
}

export function nowStamp(now = new Date()) {
  return fmtStamp(now);
}

/** 'YYYY-MM-DD' -> {y,m,d}，非法返回 null */
export function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

export function isValidDate(s) {
  return parseDate(s) !== null;
}

/** 'HH:mm' -> {h,m}，非法返回 null */
export function parseTime(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, m: mi };
}

export function isValidTime(s) {
  return parseTime(s) !== null;
}

/** 'YYYY-MM-DDTHH:mm[:ss]' -> 本地 Date，非法返回 null */
export function parseStamp(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m || !isValidDate(m[1])) return null;
  const t = parseTime(`${m[2]}:${m[3]}`);
  if (!t) return null;
  const d = parseDate(m[1]);
  return new Date(d.y, d.m - 1, d.d, t.h, t.m, m[4] ? Number(m[4]) : 0, 0);
}

export function isValidStamp(s) {
  return parseStamp(s) !== null;
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function utcMs(dateStr) {
  const p = parseDate(dateStr);
  if (!p) return NaN;
  return Date.UTC(p.y, p.m - 1, p.d);
}

function fromUtcMs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function addDays(dateStr, n) {
  return fromUtcMs(utcMs(dateStr) + n * MS_PER_DAY);
}

/** b - a 的天数（可负） */
export function diffDays(a, b) {
  return Math.round((utcMs(b) - utcMs(a)) / MS_PER_DAY);
}

export function clampDate(dateStr, min, max) {
  if (min && dateStr < min) return min;
  if (max && dateStr > max) return max;
  return dateStr;
}

/** 0=周一 … 6=周日 */
export function weekdayIndex(dateStr) {
  const d = new Date(utcMs(dateStr));
  return (d.getUTCDay() + 6) % 7;
}

export function weekdayLabel(dateStr) {
  return ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][weekdayIndex(dateStr)];
}

export function startOfWeekMonday(dateStr) {
  return addDays(dateStr, -weekdayIndex(dateStr));
}

export function endOfWeekSunday(dateStr) {
  return addDays(startOfWeekMonday(dateStr), 6);
}

/** ISO 周年（可能跨公历年） */
export function isoWeekInfo(dateStr) {
  let d = new Date(utcMs(dateStr));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d = new Date(d.getTime() - dayNum * MS_PER_DAY + 3 * MS_PER_DAY); // 本周周四
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const fdayNum = (firstThursday.getUTCDay() + 6) % 7;
  const ft = firstThursday.getTime() - fdayNum * MS_PER_DAY + 3 * MS_PER_DAY;
  const week = 1 + Math.round((d.getTime() - ft) / (7 * MS_PER_DAY));
  return { year: isoYear, week };
}

export function isoWeekLabel(dateStr) {
  const { year, week } = isoWeekInfo(dateStr);
  return `${year}-W${pad2(week)}`;
}

/** 1..4，按标准季度：1-3 月 Q1（契约 §1.1 明确 Q1 为 1/1–3/31） */
export function quarterOf(dateStr) {
  const p = parseDate(dateStr);
  if (!p) return 0;
  return Math.floor((p.m - 1) / 3) + 1;
}

export function quarterRange(year, q) {
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const startDate = `${year}-${pad2(startMonth)}-01`;
  const endDate = `${year}-${pad2(endMonth)}-${pad2(daysInMonth(year, endMonth))}`;
  return { startDate, endDate };
}

export function yearRange(year) {
  return { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

export function monthRange(year, month) {
  return {
    startDate: `${year}-${pad2(month)}-01`,
    endDate: `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`,
  };
}

/** 含该日期的 ISO 周区间（周一…周日） */
export function weekRange(dateStr) {
  const startDate = startOfWeekMonday(dateStr);
  return { startDate, endDate: addDays(startDate, 6) };
}

export function dateToLocalDate(dateStr, timeStr = '00:00') {
  const d = parseDate(dateStr);
  const t = parseTime(timeStr);
  if (!d || !t) return null;
  return new Date(d.y, d.m - 1, d.d, t.h, t.m, 0, 0);
}

export function stampOf(dateStr, timeStr = '00:00') {
  return `${dateStr}T${timeStr}:00`;
}

export function minutesOfDay(timeStr) {
  const t = parseTime(timeStr);
  if (!t) return null;
  return t.h * 60 + t.m;
}

export function timeFromMinutes(mins) {
  const v = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(v / 60))}:${pad2(v % 60)}`;
}

export function addMinutesToStamp(stamp, mins) {
  const d = parseStamp(stamp);
  if (!d) return null;
  return fmtStamp(new Date(d.getTime() + mins * 60000));
}

/** 两个 'HH:mm' 之间分钟数（可负） */
export function minutesBetween(a, b) {
  return minutesOfDay(b) - minutesOfDay(a);
}

/** [s1,e1) 与 [s2,e2) 的重叠分钟数；端点相接不算重叠 */
export function overlapMinutes(s1, e1, s2, e2) {
  const a1 = minutesOfDay(s1);
  const a2 = minutesOfDay(e1);
  const b1 = minutesOfDay(s2);
  const b2 = minutesOfDay(e2);
  if ([a1, a2, b1, b2].some((v) => v === null)) return 0;
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

/**
 * 把 precision 展开成真实区间（契约 §1.1 精度语义）。
 * 返回 { startDate, endDate, startTime, endTime }，unscheduled 全部为 null。
 * 这是"绝不把年度目标当成某一天某一刻"的唯一实现点，其它模块只能调它。
 */
export function expandPrecision(precision, startDate, opts = {}) {
  const empty = { startDate: null, endDate: null, startTime: null, endTime: null };
  if (!precision || precision === 'unscheduled') return empty;
  if (!isValidDate(startDate)) return empty;
  switch (precision) {
    case 'year': {
      const y = parseDate(startDate).y;
      const r = yearRange(y);
      return { startDate: r.startDate, endDate: r.endDate, startTime: null, endTime: null };
    }
    case 'quarter': {
      const p = parseDate(startDate);
      const r = quarterRange(p.y, quarterOf(startDate));
      return { startDate: r.startDate, endDate: r.endDate, startTime: null, endTime: null };
    }
    case 'month': {
      const p = parseDate(startDate);
      const r = monthRange(p.y, p.m);
      return { startDate: r.startDate, endDate: r.endDate, startTime: null, endTime: null };
    }
    case 'week': {
      const r = weekRange(startDate);
      return { startDate: r.startDate, endDate: r.endDate, startTime: null, endTime: null };
    }
    case 'day': {
      // 「日」默认单日；但如果显式给了不早于开始日的结束日期，就当成连续多天
      // （用户写「11-09 到 11-12 做论文修改」时不能把结束日丢掉）
      const end = isValidDate(opts.endDate) && opts.endDate >= startDate ? opts.endDate : startDate;
      return { startDate, endDate: end, startTime: null, endTime: null };
    }
    case 'slot':
      return {
        startDate,
        endDate: startDate,
        startTime: opts.startTime ?? null,
        endTime: opts.endTime ?? null,
      };
    default:
      return empty;
  }
}

/** 季度标签，如 '2027 Q2' */
export function quarterLabel(dateStr) {
  const p = parseDate(dateStr);
  if (!p) return null;
  return `${p.y} Q${quarterOf(dateStr)}`;
}

/** 展示用的中文区间描述（提醒正文/分析文案用） */
export function describeInterval(item) {
  if (!item) return '';
  if (item.precision === 'unscheduled' || !item.startDate) return '未安排时间';
  if (item.precision === 'slot') {
    return `${item.startDate} ${item.startTime || ''}-${item.endTime || ''}`.trim();
  }
  if (item.precision === 'day') return `${item.startDate} 全天`;
  if (item.precision === 'week') return `${item.startDate} 那周（${isoWeekLabel(item.startDate)}）`;
  if (item.precision === 'month') return `${item.startDate.slice(0, 7)}`;
  if (item.precision === 'quarter') return quarterLabel(item.startDate);
  if (item.precision === 'year') return `${item.startDate.slice(0, 4)} 年`;
  return `${item.startDate} ~ ${item.endDate}`;
}

/** 两个时间戳字符串可直接字典序比较（同格式无偏移） */
export function stampLte(a, b) {
  return String(a) <= String(b);
}
