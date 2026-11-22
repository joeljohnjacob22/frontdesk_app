import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendar } from '../server/lib/calendar.js';
import {
  startCycle, recomputeForPriority, dueDates, pausedMinutes,
  autoCloseAt, reopenUntil, isOverdue,
} from '../server/lib/sla.js';
import { ist, fmt } from './helpers/time.js';

const engine = {
  calendar: createCalendar({ holidays: ['2026-12-25'] }),
  policies: {
    high:   { replyMinutes: 120, resolveMinutes: null, resolveSameDay: true },
    medium: { replyMinutes: 270, resolveMinutes: 1620, resolveSameDay: false },
    low:    { replyMinutes: 540, resolveMinutes: 2700, resolveSameDay: false },
  },
  autoCloseMinutes: 2700,
  reopenMinutes: 2700,
};

test('Friday 6 PM High ticket: due Monday, NOT late on Sunday morning', () => {
  const c = startCycle(engine, 'high', ist('2026-11-20 18:00'));
  assert.equal(fmt(c.clockStartAt), '2026-11-20 18:00');
  assert.equal(c.replyBudgetMinutes, 120);
  assert.equal(fmt(c.replyDueAt), '2026-11-23 11:00');          // 30 Fri + 90 Mon
  assert.equal(c.resolveBudgetMinutes, 30);                     // 18:00 -> 18:30 same day
  assert.equal(fmt(c.resolveDueAt), '2026-11-20 18:30');
  // The spreadsheet said "late" here. We must not.
  assert.equal(isOverdue(c.replyDueAt, ist('2026-11-22 10:00')), false);
  assert.equal(isOverdue(c.replyDueAt, ist('2026-11-23 11:00')), false);    // exactly due: not late
  assert.equal(isOverdue(c.replyDueAt, ist('2026-11-23 11:00:01')), true);
});

test('High ticket arriving on a Saturday starts Monday 09:30', () => {
  const c = startCycle(engine, 'high', ist('2026-11-21 11:00'));
  assert.equal(fmt(c.startedAt), '2026-11-21 11:00');           // real arrival is kept
  assert.equal(fmt(c.clockStartAt), '2026-11-23 09:30');
  assert.equal(fmt(c.replyDueAt), '2026-11-23 11:30');
  assert.equal(c.resolveBudgetMinutes, 540);
  assert.equal(fmt(c.resolveDueAt), '2026-11-23 18:30');
});

test('High ticket arriving exactly at 18:30 starts the next working morning', () => {
  const c = startCycle(engine, 'high', ist('2026-11-23 18:30'));
  assert.equal(fmt(c.clockStartAt), '2026-11-24 09:30');
  assert.equal(fmt(c.resolveDueAt), '2026-11-24 18:30');
});

test('High ticket arriving 30 seconds before close gets a 1-minute budget, not 0', () => {
  const c = startCycle(engine, 'high', ist('2026-11-23 18:29:30'));
  assert.equal(fmt(c.clockStartAt), '2026-11-23 18:29');
  assert.equal(c.resolveBudgetMinutes, 1);
  assert.equal(fmt(c.resolveDueAt), '2026-11-23 18:30');
});

test('Medium ticket Friday 17:00', () => {
  const c = startCycle(engine, 'medium', ist('2026-11-20 17:00'));
  assert.equal(c.replyBudgetMinutes, 270);
  assert.equal(c.resolveBudgetMinutes, 1620);
  assert.equal(fmt(c.replyDueAt), '2026-11-23 12:30');
  assert.equal(fmt(c.resolveDueAt), '2026-11-25 17:00');
});

test('Low ticket Monday 10:00', () => {
  const c = startCycle(engine, 'low', ist('2026-11-23 10:00'));
  assert.equal(fmt(c.replyDueAt), '2026-11-24 10:00');
  assert.equal(fmt(c.resolveDueAt), '2026-11-30 10:00');        // 2700 min = 5 working days (+30 min)
});

test('pause: waiting time is added to the resolve deadline, reply deadline untouched', () => {
  const c = startCycle(engine, 'medium', ist('2026-11-20 17:00'));
  const paused = pausedMinutes(engine, ist('2026-11-20 17:20'), ist('2026-11-25 10:00'));
  assert.equal(paused, 1180);
  const due = dueDates(engine, { ...c, pausedBusinessMinutes: paused });
  assert.equal(fmt(due.resolveDueAt), '2026-11-30 09:40');      // 1620 + 1180 = 2800 min
  assert.equal(fmt(due.replyDueAt), '2026-11-23 12:30');        // unchanged
});

test('priority change: escalating keeps the clock start, so the ticket can be instantly late', () => {
  const c = startCycle(engine, 'medium', ist('2026-11-23 10:00'));
  const up = recomputeForPriority(engine, c, 'high', 0);
  assert.equal(up.priority, 'high');
  assert.equal(fmt(up.replyDueAt), '2026-11-23 12:00');         // from the ORIGINAL start, not from now
  assert.equal(up.resolveBudgetMinutes, 510);                   // 10:00 -> 18:30 on the start day
  assert.equal(fmt(up.resolveDueAt), '2026-11-23 18:30');
  assert.equal(isOverdue(up.resolveDueAt, ist('2026-11-25 09:00')), true);   // escalated on Wednesday
});

test('priority change: downgrading moves deadlines later and keeps pauses', () => {
  const c = startCycle(engine, 'high', ist('2026-11-23 10:00'));
  const down = recomputeForPriority(engine, c, 'low', 0);
  assert.equal(fmt(down.replyDueAt), '2026-11-24 10:00');
  assert.equal(fmt(down.resolveDueAt), '2026-11-30 10:00');
  const withPause = recomputeForPriority(engine, c, 'low', 540);
  assert.equal(fmt(withPause.resolveDueAt), '2026-12-01 10:00');   // one extra working day
});

test('priority change counts from the cycle clock start, not the real arrival time', () => {
  // Arrived 18:29:30: the clock started at 18:29 (floored). Escalating to High must still be due 18:30 today.
  const c = startCycle(engine, 'medium', ist('2026-11-23 18:29:30'));
  assert.equal(fmt(c.clockStartAt), '2026-11-23 18:29');
  const up = recomputeForPriority(engine, c, 'high', 0);
  assert.equal(up.resolveBudgetMinutes, 1);
  assert.equal(fmt(up.resolveDueAt), '2026-11-23 18:30');
});

test('priority change does not mutate the cycle it was given', () => {
  const c = Object.freeze(startCycle(engine, 'medium', ist('2026-11-23 10:00')));
  assert.doesNotThrow(() => recomputeForPriority(engine, c, 'high', 0));
});

test('auto-close and reopen windows are 5 working days', () => {
  // Waiting since Friday 17:20 -> next Friday 17:20.
  assert.equal(fmt(autoCloseAt(engine, ist('2026-11-20 17:20'))), '2026-11-27 17:20');
  // Resolved Wed 23 Dec 12:00; Dec 25 is a holiday -> reopen until Thu 31 Dec 12:00.
  assert.equal(fmt(reopenUntil(engine, ist('2026-12-23 12:00'))), '2026-12-31 12:00');
});

test('unknown priority is rejected', () => {
  assert.throws(() => startCycle(engine, 'urgent', ist('2026-11-23 10:00')), RangeError);
});
