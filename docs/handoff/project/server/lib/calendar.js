const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;
const MAX_SCAN_DAYS = 3700;   // ~10 years: a calendar with no working days must fail, not loop forever

// Fixed UTC offsets in minutes. Only add zones that have NO daylight saving.
export const ZONE_OFFSETS = Object.freeze({ 'Asia/Kolkata': 330, UTC: 0 });

export function toMs(value) {
  const ms = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
    : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`Invalid time value: ${String(value)}`);
  return ms;
}

export function floorToMinute(value) {
  return new Date(Math.floor(toMs(value) / MS_PER_MIN) * MS_PER_MIN);
}

function parseClock(text) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(text));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new RangeError(`Bad HH:MM value: ${text}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function createCalendar({
  timezone = 'Asia/Kolkata',
  workStart = '09:30',
  workEnd = '18:30',
  workDays = [1, 2, 3, 4, 5],
  holidays = [],
} = {}) {
  const offsetMin = ZONE_OFFSETS[timezone];
  if (offsetMin === undefined) throw new Error(`Unsupported timezone "${timezone}" (no fixed offset known)`);
  const startMin = parseClock(workStart);
  const endMin = parseClock(workEnd);
  if (startMin >= endMin) throw new RangeError('workStart must be before workEnd');
  const weekdays = new Set(workDays);
  if (weekdays.size === 0) throw new RangeError('workDays must not be empty');
  const holidaySet = new Set(holidays);

  // --- local-day arithmetic (all on epoch milliseconds, never Date local-time methods) ---
  const localMs = (ms) => ms + offsetMin * MS_PER_MIN;
  const dayOf = (ms) => Math.floor(localMs(ms) / MS_PER_DAY);
  const minuteOfDay = (ms) => (localMs(ms) - dayOf(ms) * MS_PER_DAY) / MS_PER_MIN;
  const instant = (day, minute) => day * MS_PER_DAY + minute * MS_PER_MIN - offsetMin * MS_PER_MIN;
  const isoWeekday = (day) => ((((day + 3) % 7) + 7) % 7) + 1;      // 1970-01-01 was a Thursday
  const dateString = (day) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
  const isWorkingDayNumber = (day) => weekdays.has(isoWeekday(day)) && !holidaySet.has(dateString(day));

  function nextOpeningMs(ms) {
    const day = dayOf(ms);
    if (isWorkingDayNumber(day)) {
      const m = minuteOfDay(ms);
      if (m < startMin) return instant(day, startMin);
      if (m < endMin) return ms;                                    // half-open: 18:30 itself is closed
    }
    for (let d = day + 1; d <= day + MAX_SCAN_DAYS; d++) {
      if (isWorkingDayNumber(d)) return instant(d, startMin);
    }
    throw new Error('No working day found within 10 years: check the calendar settings');
  }

  function addBusinessMinutes(start, minutes) {
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
      throw new RangeError('minutes must be a non-negative finite number');
    }
    let t = nextOpeningMs(toMs(start));
    let remaining = minutes * MS_PER_MIN;
    for (let guard = 0; guard <= MAX_SCAN_DAYS; guard++) {            // one pass per working day
      const close = instant(dayOf(t), endMin);
      const available = close - t;
      if (remaining <= available) return new Date(t + remaining);   // exact fit stays on this day
      remaining -= available;
      t = nextOpeningMs(close);
    }
    throw new RangeError('Business-time span is too long (or the calendar is misconfigured)');
  }

  function businessMinutesBetween(from, to) {
    const a = toMs(from);
    const b = toMs(to);
    if (b <= a) return 0;
    let total = 0;
    for (let d = dayOf(a); d <= dayOf(b); d++) {
      if (!isWorkingDayNumber(d)) continue;
      const lo = Math.max(a, instant(d, startMin));
      const hi = Math.min(b, instant(d, endMin));
      if (hi > lo) total += hi - lo;
    }
    return Math.floor(total / MS_PER_MIN);
  }

  return Object.freeze({
    isWorkingDay: (t) => isWorkingDayNumber(dayOf(toMs(t))),
    nextOpening: (t) => new Date(nextOpeningMs(toMs(t))),
    addBusinessMinutes,
    businessMinutesBetween,
    closingTime: (t) => new Date(instant(dayOf(toMs(t)), endMin)),
    localDate: (t) => dateString(dayOf(toMs(t))),
  });
}
