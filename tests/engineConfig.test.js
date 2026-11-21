import test from 'node:test';
import assert from 'node:assert/strict';
import { holidays } from '../db/schema.js';
import { loadEngineConfig } from '../server/lib/engineConfig.js';
import { startCycle } from '../server/lib/sla.js';
import { createTestDb } from './helpers/testDb.js';
import { ist, fmt } from './helpers/time.js';

const ctx = await createTestDb();
test.after(() => ctx.drop());

test('loads policies, windows and calendar from the seeded tables', async () => {
  const engine = await loadEngineConfig(ctx.db);
  assert.deepEqual(engine.policies, {
    high:   { replyMinutes: 120, resolveMinutes: null, resolveSameDay: true },
    medium: { replyMinutes: 270, resolveMinutes: 1620, resolveSameDay: false },
    low:    { replyMinutes: 540, resolveMinutes: 2700, resolveSameDay: false },
  });
  assert.equal(engine.autoCloseMinutes, 2700);
  assert.equal(engine.reopenMinutes, 2700);
  assert.equal(engine.calendar.isWorkingDay(ist('2026-12-25 12:00')), false);   // seeded holiday
  assert.equal(engine.calendar.isWorkingDay(ist('2026-12-24 12:00')), true);
});

test('the loaded engine produces the Friday 6 PM answer end to end', async () => {
  const engine = await loadEngineConfig(ctx.db);
  const c = startCycle(engine, 'high', ist('2026-11-20 18:00'));
  assert.equal(fmt(c.replyDueAt), '2026-11-23 11:00');
});

test('holidays are editable data: a new row changes the calendar on the next load', async () => {
  await ctx.db.insert(holidays).values({ holidayDate: '2026-11-24', name: 'Test holiday' });
  const engine = await loadEngineConfig(ctx.db);
  assert.equal(engine.calendar.isWorkingDay(ist('2026-11-24 12:00')), false);
  // Mon 23 Nov 18:00 + 120 min: 30 min Monday, Tue is a holiday, 90 min Wed.
  assert.equal(fmt(engine.calendar.addBusinessMinutes(ist('2026-11-23 18:00'), 120)), '2026-11-25 11:00');
});

test('a missing setting fails loudly instead of silently using a default', async () => {
  await ctx.pool.query(`DELETE FROM settings WHERE key = 'work_end'`);
  await assert.rejects(loadEngineConfig(ctx.db), /work_end/);
});
