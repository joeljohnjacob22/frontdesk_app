const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const MAX_SCAN_DAYS = 3_700;

export const ZONE_OFFSETS = Object.freeze({
  'Asia/Kolkata': 330,
  UTC: 0,
});

function validIsoDate(value) {
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && dateKey(Math.floor(ms / MS_PER_DAY)) === value;
}

export function toMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isFinite(ms)) return ms;
    throw new TypeError('Expected a valid date');
  }
  if (typeof value === 'number') {
    const ms = new Date(value).getTime();
    if (Number.isFinite(ms)) return ms;
    throw new TypeError('Expected valid epoch milliseconds');
  }
  if (typeof value === 'string') {
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;
    if ((isoDate.test(value) || isoDateTime.test(value)) && validIsoDate(value.slice(0, 10))) {
      const withUtc = isoDateTime.test(value) && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        ? `${value}Z`
        : value;
      const ms = Date.parse(withUtc);
      if (Number.isFinite(ms)) return ms;
    }
  }
  throw new TypeError('Expected a Date, epoch milliseconds, or ISO date string');
}

export function floorToMinute(value) {
  return new Date(Math.floor(toMs(value) / MS_PER_MINUTE) * MS_PER_MINUTE);
}

function parseTime(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must use HH:MM format`);
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(value);
  if (!match) throw new RangeError(`${name} must use HH:MM format`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function dateKey(day) {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

function validateHoliday(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !validIsoDate(value)) {
    throw new RangeError(`Invalid holiday date: ${value}`);
  }
  return value;
}

export function createCalendar({
  timezone = 'Asia/Kolkata',
  workStart = '09:30',
  workEnd = '18:30',
  workDays = [1, 2, 3, 4, 5],
  holidays = [],
} = {}) {
  if (!Object.hasOwn(ZONE_OFFSETS, timezone)) {
    throw new RangeError(`Unsupported timezone: ${timezone}`);
  }
  const offsetMs = ZONE_OFFSETS[timezone] * MS_PER_MINUTE;
  const startMinute = parseTime(workStart, 'workStart');
  const endMinute = parseTime(workEnd, 'workEnd');
  if (startMinute >= endMinute) throw new RangeError('workStart must be before workEnd');
  if (!Array.isArray(workDays)) throw new TypeError('workDays must be an array');
  if (workDays.length === 0) throw new RangeError('At least one work day is required');
  if (!workDays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) {
    throw new RangeError('workDays must contain ISO weekdays from 1 to 7');
  }
  if (!Array.isArray(holidays)) throw new TypeError('holidays must be an array');

  const workingDays = new Set(workDays);
  const holidayDates = new Set(holidays.map(validateHoliday));

  function localParts(value) {
    const localMs = toMs(value) + offsetMs;
    const day = Math.floor(localMs / MS_PER_DAY);
    const minuteOfDay = (localMs - day * MS_PER_DAY) / MS_PER_MINUTE;
    return { day, minuteOfDay };
  }

  function isWorkingDayNumber(day) {
    const isoWeekday = ((((day + 3) % 7) + 7) % 7) + 1;
    return workingDays.has(isoWeekday) && !holidayDates.has(dateKey(day));
  }

  function instantAt(day, minute) {
    return new Date(day * MS_PER_DAY + minute * MS_PER_MINUTE - offsetMs);
  }

  function nextOpening(value) {
    const utcMs = toMs(value);
    const { day, minuteOfDay } = localParts(utcMs);
    for (let scanned = 0; scanned < MAX_SCAN_DAYS; scanned++) {
      const candidateDay = day + scanned;
      if (!isWorkingDayNumber(candidateDay)) continue;
      if (scanned === 0) {
        if (minuteOfDay >= endMinute) continue;
        if (minuteOfDay >= startMinute) return new Date(utcMs);
      }
      return instantAt(candidateDay, startMinute);
    }
    throw new RangeError(`No working day found within ${MAX_SCAN_DAYS} days`);
  }

  function addBusinessMinutes(start, minutes) {
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) {
      throw new RangeError('Business minutes must be a non-negative finite number');
    }
    let utcMs = toMs(nextOpening(start));
    let remainingMs = minutes * MS_PER_MINUTE;
    if (remainingMs === 0) return new Date(utcMs);

    for (let scanned = 0; scanned < MAX_SCAN_DAYS; scanned++) {
      const { day } = localParts(utcMs);
      const closeMs = toMs(instantAt(day, endMinute));
      const availableMs = closeMs - utcMs;
      if (remainingMs <= availableMs) return new Date(utcMs + remainingMs);
      remainingMs -= availableMs;
      utcMs = toMs(nextOpening(closeMs));
    }
    throw new RangeError(`Business-minute addition exceeded ${MAX_SCAN_DAYS} working days`);
  }

  function businessMinutesBetween(a, b) {
    const startMs = toMs(a);
    const endMs = toMs(b);
    if (endMs <= startMs) return 0;

    const firstDay = localParts(startMs).day;
    const lastDay = localParts(endMs).day;
    const dayCount = lastDay - firstDay + 1;
    if (dayCount > MAX_SCAN_DAYS) {
      throw new RangeError(`Business-time interval exceeded ${MAX_SCAN_DAYS} days`);
    }

    let overlapMs = 0;
    for (let day = firstDay; day <= lastDay; day++) {
      if (!isWorkingDayNumber(day)) continue;
      const openingMs = toMs(instantAt(day, startMinute));
      const closingMs = toMs(instantAt(day, endMinute));
      const overlapStart = Math.max(startMs, openingMs);
      const overlapEnd = Math.min(endMs, closingMs);
      if (overlapEnd > overlapStart) overlapMs += overlapEnd - overlapStart;
    }
    return Math.floor(overlapMs / MS_PER_MINUTE);
  }

  function closingTime(value) {
    return instantAt(localParts(value).day, endMinute);
  }

  function isWorkingDay(value) {
    return isWorkingDayNumber(localParts(value).day);
  }

  function localDate(value) {
    return dateKey(localParts(value).day);
  }

  return Object.freeze({
    isWorkingDay,
    nextOpening,
    addBusinessMinutes,
    businessMinutesBetween,
    closingTime,
    localDate,
  });
}
