import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendar } from '../server/lib/calendar.js';
import { ist, fmt } from './helpers/time.js';

const cal = createCalendar({ holidays: ['2026-12-25'] });

test('isWorkingDay: weekdays yes, weekends no, holidays no', () => {
  assert.equal(cal.isWorkingDay(ist('2026-11-20 12:00')), true);   // Fri
  assert.equal(cal.isWorkingDay(ist('2026-11-21 12:00')), false);  // Sat
  assert.equal(cal.isWorkingDay(ist('2026-11-22 12:00')), false);  // Sun
  assert.equal(cal.isWorkingDay(ist('2026-11-23 12:00')), true);   // Mon
  assert.equal(cal.isWorkingDay(ist('2026-12-25 12:00')), false);  // Christmas (Fri)
});

test('isWorkingDay uses the IST day, not the UTC day', () => {
  // 00:30 IST Monday is still Sunday 19:00 in UTC.
  assert.equal(cal.isWorkingDay(ist('2026-11-23 00:30')), true);
  assert.equal(cal.localDate(ist('2026-11-23 00:30')), '2026-11-23');
});

test('nextOpening', () => {
  const cases = [
    ['2026-11-20 18:00', '2026-11-20 18:00'],   // inside hours: unchanged
    ['2026-11-23 09:30', '2026-11-23 09:30'],   // exactly at opening: open
    ['2026-11-23 08:00', '2026-11-23 09:30'],   // before opening
    ['2026-11-20 18:30', '2026-11-23 09:30'],   // exactly at close: closed -> Monday
    ['2026-11-20 18:30:01', '2026-11-23 09:30'],
    ['2026-11-21 12:00', '2026-11-23 09:30'],   // Saturday
    ['2026-11-22 23:59', '2026-11-23 09:30'],   // Sunday night
    ['2026-12-24 18:40', '2026-12-28 09:30'],   // Thu night -> skips holiday Fri + weekend
  ];
  for (const [input, expected] of cases) {
    assert.equal(fmt(cal.nextOpening(ist(input))), expected, `nextOpening(${input})`);
  }
});

test('addBusinessMinutes', () => {
  const cases = [
    ['2026-11-20 18:00', 120, '2026-11-23 11:00'],   // Friday 6 PM + 2 h = Monday 11:00
    ['2026-11-23 09:30', 540, '2026-11-23 18:30'],   // a full day ends at 18:30 the same day
    ['2026-11-23 09:30', 541, '2026-11-24 09:31'],
    ['2026-11-20 17:00', 270, '2026-11-23 12:30'],   // Medium reply
    ['2026-11-20 17:00', 1620, '2026-11-25 17:00'],  // Medium resolve
    ['2026-11-21 12:00', 120, '2026-11-23 11:30'],   // starts on Saturday
    ['2026-11-21 12:00', 0, '2026-11-23 09:30'],     // zero minutes -> next opening
    ['2026-11-23 09:30', 2700, '2026-11-27 18:30'],  // five full days
    ['2026-12-24 17:30', 120, '2026-12-28 10:30'],   // skips the Dec 25 holiday and the weekend
  ];
  for (const [start, minutes, expected] of cases) {
    assert.equal(fmt(cal.addBusinessMinutes(ist(start), minutes)), expected, `${start} + ${minutes}`);
  }
});

test('addBusinessMinutes rejects negative or non-numeric minutes and never mutates input', () => {
  assert.throws(() => cal.addBusinessMinutes(ist('2026-11-20 10:00'), -1), RangeError);
  assert.throws(() => cal.addBusinessMinutes(ist('2026-11-20 10:00'), NaN), RangeError);
  const start = ist('2026-11-20 10:00');
  const before = start.getTime();
  cal.addBusinessMinutes(start, 5000);
  assert.equal(start.getTime(), before);
});

test('businessMinutesBetween', () => {
  const cases = [
    ['2026-11-20 18:00', '2026-11-23 10:00', 60],     // 30 Fri + 30 Mon
    ['2026-11-21 10:00', '2026-11-22 10:00', 0],      // weekend
    ['2026-11-23 09:30', '2026-11-23 18:30', 540],    // one full day
    ['2026-11-23 00:00', '2026-11-25 00:00', 1080],   // Mon + Tue
    ['2026-12-24 09:30', '2026-12-28 18:30', 1080],   // Thu + Mon (Fri holiday, weekend)
    ['2026-11-23 12:00', '2026-11-23 12:00', 0],      // empty
    ['2026-11-23 12:00', '2026-11-23 11:00', 0],      // reversed
    ['2026-11-20 17:20', '2026-11-25 10:00', 1180],   // the pause example: 70+540+540+30
  ];
  for (const [a, b, expected] of cases) {
    assert.equal(cal.businessMinutesBetween(ist(a), ist(b)), expected, `${a} -> ${b}`);
  }
});

test('closingTime is 18:30 of the same local day', () => {
  assert.equal(fmt(cal.closingTime(ist('2026-11-23 12:00'))), '2026-11-23 18:30');
  assert.equal(fmt(cal.closingTime(ist('2026-11-23 09:30'))), '2026-11-23 18:30');
});

test('property: add and between are inverses (500 pseudo-random cases)', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const base = ist('2026-11-01 00:00').getTime();
  for (let i = 0; i < 500; i++) {
    const start = new Date(base + Math.floor(rnd() * 92 * 86_400_000));   // Nov 1 .. Jan 31
    const n = 1 + Math.floor(rnd() * 4000);
    const end = cal.addBusinessMinutes(start, n);
    assert.equal(cal.businessMinutesBetween(cal.nextOpening(start), end), n, `start=${start.toISOString()} n=${n}`);
    // The result is always inside working time or exactly at a closing time.
    assert.equal(cal.isWorkingDay(new Date(end.getTime() - 1)), true);
    assert.ok(cal.addBusinessMinutes(start, n + 1) > end, 'strictly increasing');
  }
});

test('invalid calendars are rejected', () => {
  assert.throws(() => createCalendar({ timezone: 'Europe/London' }), /Unsupported timezone/);
  assert.throws(() => createCalendar({ workStart: '18:30', workEnd: '09:30' }));
  assert.throws(() => createCalendar({ workDays: [] }));
});
