import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { tickets } from '../db/schema.js';
import { runTick, startTickJob } from '../server/jobs/tick.js';
import { createWorld } from './helpers/world.js';

const world = await createWorld();
test.after(async () => { await world.drop(); });

test('reply breach is recorded once at the deadline', async () => {
  const { ticket } = await world.newTicket({ priority: 'high' });
  const [cycle] = await world.cycles(ticket.id);

  await runTick(world.db, world.engine, cycle.replyDueAt);
  await runTick(world.db, world.engine, cycle.replyDueAt);

  const [after] = await world.cycles(ticket.id);
  assert.equal(after.replyBreachedAt.getTime(), cycle.replyDueAt.getTime());
  const events = await world.events(ticket.id);
  assert.equal(events.filter((event) => event.type === 'reply_breached').length, 1);
  assert.deepEqual(events.find((event) => event.type === 'reply_breached').payload, {
    due_at: cycle.replyDueAt.toISOString(),
    detected_by: 'tick',
  });
});

test('waiting tickets are not marked breached while the SLA clock is paused', async () => {
  world.clock.set('2026-11-23 10:00');
  const { ticket } = await world.claimed({ priority: 'medium' });
  await world.svc.replyPublic(ticket.id, world.agent, {
    body: 'Please provide more information.',
    setWaiting: true,
  });
  const cycle = await world.cycle(ticket.id);

  await runTick(world.db, world.engine, new Date(cycle.resolveDueAt.getTime() + 1));

  const after = await world.cycle(ticket.id);
  assert.equal(after.resolveBreachedAt, null);
  assert.ok(!(await world.eventTypes(ticket.id)).includes('resolve_breached'));
  assert.equal((await world.ticket(ticket.id)).status, 'waiting_on_customer');
});

test('waiting tickets auto-close at the exact deadline and close the pause and cycle', async () => {
  world.clock.set('2026-11-23 10:00');
  const { ticket } = await world.claimed({ priority: 'high' });
  await world.svc.replyPublic(ticket.id, world.agent, {
    body: 'Can you confirm the account name?',
    setWaiting: true,
  });
  const before = await world.ticket(ticket.id);
  const now = before.autoCloseAt;

  await runTick(world.db, world.engine, now);
  await runTick(world.db, world.engine, now);

  const after = await world.ticket(ticket.id);
  assert.equal(after.status, 'closed');
  assert.equal(after.closedReason, 'customer_no_reply');
  assert.equal(after.closedAt.getTime(), now.getTime());
  assert.equal(after.waitingSince, null);
  assert.equal(after.autoCloseAt, null);
  const [pause] = await world.pauses(ticket.id);
  assert.equal(pause.resumedAt.getTime(), now.getTime());
  assert.notEqual(pause.businessMinutes, null);
  const [cycle] = await world.cycles(ticket.id);
  assert.equal(cycle.endedAt.getTime(), now.getTime());
  const events = await world.events(ticket.id);
  assert.equal(events.filter((event) => event.type === 'auto_closed').length, 1);
  assert.equal(events.filter((event) => event.type === 'status_changed').length, 2);
});

test('waiting tickets auto-close when the tick runs just after the deadline', async () => {
  world.clock.set('2026-11-23 10:00');
  const { ticket } = await world.claimed({ priority: 'high' });
  await world.svc.replyPublic(ticket.id, world.agent, {
    body: 'Please confirm the account name.',
    setWaiting: true,
  });
  const before = await world.ticket(ticket.id);
  const now = new Date(before.autoCloseAt.getTime() + 60_000);

  await runTick(world.db, world.engine, now);

  const after = await world.ticket(ticket.id);
  assert.equal(after.status, 'closed');
  assert.equal(after.closedAt.getTime(), now.getTime());
  const [pause] = await world.pauses(ticket.id);
  assert.equal(pause.resumedAt.getTime(), now.getTime());
});

test('resolved tickets close at the reopen deadline', async () => {
  world.clock.set('2026-11-23 10:00');
  const { ticket } = await world.claimed();
  await world.svc.resolveTicket(ticket.id, world.agent);
  const resolved = await world.ticket(ticket.id);

  await runTick(world.db, world.engine, resolved.reopenUntil);

  const after = await world.ticket(ticket.id);
  assert.equal(after.status, 'closed');
  assert.equal(after.closedReason, 'resolution_window_elapsed');
  assert.equal(after.closedAt.getTime(), resolved.reopenUntil.getTime());
  assert.ok((await world.eventTypes(ticket.id)).includes('closed'));
});

test('tick skips a ticket whose row is locked by another transaction', async () => {
  const { ticket } = await world.newTicket({ priority: 'high' });
  const [cycle] = await world.cycles(ticket.id);
  let releaseLock;
  let signalLocked;
  const locked = new Promise((resolve) => { signalLocked = resolve; });
  const hold = new Promise((resolve) => { releaseLock = resolve; });

  const lockTransaction = world.db.transaction(async (tx) => {
    await tx.select({ id: tickets.id }).from(tickets)
      .where(eq(tickets.id, ticket.id))
      .for('update');
    signalLocked();
    await hold;
  });
  await locked;
  try {
    await runTick(world.db, world.engine, cycle.replyDueAt);
    const [unchanged] = await world.cycles(ticket.id);
    assert.equal(unchanged.replyBreachedAt, null);
  } finally {
    releaseLock();
    await lockTransaction;
  }

  await runTick(world.db, world.engine, cycle.replyDueAt);
  const [after] = await world.cycles(ticket.id);
  assert.ok(after.replyBreachedAt);
});

test('each tick writes state and events without changing unrelated tickets', async () => {
  const first = await world.newTicket({ email: 'tick-one@example.com', priority: 'high' });
  const [firstCycle] = await world.cycles(first.ticket.id);
  world.clock.setMs(firstCycle.replyDueAt.getTime() + 30 * 86_400_000);
  const second = await world.newTicket({ email: 'tick-two@example.com', priority: 'high' });

  await runTick(world.db, world.engine, firstCycle.replyDueAt);

  const [firstAfter] = await world.cycles(first.ticket.id);
  const [secondAfter] = await world.cycles(second.ticket.id);
  assert.ok(firstAfter.replyBreachedAt);
  assert.equal(secondAfter.replyBreachedAt, null);
});

test('scheduler runs immediately, avoids overlapping ticks, and stops cleanly', async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let stop;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    stop = startTickJob({
      db: world.db,
      getEngine: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(45);
        active -= 1;
        return world.engine;
      },
      intervalMs: 20,
      clock: async () => new Date('1970-01-01T00:00:00Z'),
      logger: { error: assert.fail },
    });
    assert.equal(calls, 1);
    await delay(130);
    await stop();
    const callsWhenStopped = calls;
    await delay(60);
    assert.ok(callsWhenStopped >= 2);
    assert.equal(maxActive, 1);
    assert.equal(calls, callsWhenStopped);
  } finally {
    if (stop) await stop();
  }
});
