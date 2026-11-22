import test from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { slaCycles, tickets, customers, messages } from '../db/schema.js';
import { sha, createWorld, rejectsWith } from './helpers/world.js';
import { fmt } from './helpers/time.js';

const world = await createWorld();
const { svc, db, clock, lead, agent, agent2 } = world;
test.after(() => world.drop());

// Fake-clock cheat sheet (IST): Fri 2026-11-20, Mon 11-23, Tue 11-24, Wed 11-25, Fri 11-27, Mon 11-30.

test('createTicket: status new, SLA cycle started, token stored only as a hash', async () => {
  clock.set('2026-11-20 17:00');
  const { ticket, token } = await world.newTicket({ priority: 'medium' });
  assert.equal(ticket.status, 'new');
  assert.equal(ticket.assigneeId, null);
  assert.ok(token.length >= 30);
  assert.deepEqual(ticket.accessTokenHash, sha(token));              // only the hash is stored
  const c = await world.cycle(ticket.id);
  assert.equal(c.cycleNo, 1);
  assert.equal(c.isReopen, false);
  assert.equal(fmt(c.replyDueAt), '2026-11-23 12:30');
  assert.equal(fmt(c.resolveDueAt), '2026-11-25 17:00');
  assert.deepEqual(await world.eventTypes(ticket.id), ['ticket_created', 'sla_cycle_started']);
});

test('createTicket reuses one customer row per email, ignoring case', async () => {
  await world.newTicket({ email: 'Same.Person@Example.com', name: 'First' });
  await world.newTicket({ email: 'same.person@example.COM', name: 'Second' });
  const rows = await db.select().from(customers).where(sql`lower(${customers.email}) = 'same.person@example.com'`);
  assert.equal(rows.length, 1);
});

test('claim: ticket becomes open and the claim is logged', async () => {
  clock.set('2026-11-20 17:00');
  const { ticket } = await world.newTicket();
  const claimed = await svc.claimTicket(ticket.id, agent);
  assert.equal(claimed.status, 'open');
  assert.equal(claimed.assigneeId, agent.id);
  assert.deepEqual((await world.eventTypes(ticket.id)).slice(-1), ['claimed']);
});

test('INC-0291: a second agent cannot claim a claimed ticket', async () => {
  const { ticket } = await world.newTicket();
  await svc.claimTicket(ticket.id, agent);
  await rejectsWith(svc.claimTicket(ticket.id, agent2), 409, 'already_claimed');
  assert.equal((await world.ticket(ticket.id)).assigneeId, agent.id);   // unchanged
});

test('INC-0291: nine agents claim at the same instant, exactly one wins', async () => {
  const { ticket } = await world.newTicket();
  const results = await Promise.allSettled(world.agents.map((a) => svc.claimTicket(ticket.id, a)));
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1);
  assert.equal(lost.length, 8);
  assert.ok(lost.every((r) => r.reason.status === 409 && r.reason.code === 'already_claimed'));
  const claimedEvents = (await world.events(ticket.id)).filter((e) => e.type === 'claimed');
  assert.equal(claimedEvents.length, 1);
});

test('INC-0291: only the owner may reply; an unclaimed ticket must be claimed first', async () => {
  const { ticket } = await world.newTicket();
  await rejectsWith(svc.replyPublic(ticket.id, agent, { body: 'hi' }), 409, 'claim_required');
  await svc.claimTicket(ticket.id, agent);
  await rejectsWith(svc.replyPublic(ticket.id, agent2, { body: 'hi' }), 403, 'not_owner');
  await rejectsWith(svc.replyPublic(ticket.id, lead, { body: 'hi' }), 403, 'not_owner');   // a lead must reassign first
});

test('a note never counts as the first response; a public reply does', async () => {
  clock.set('2026-11-23 10:00');
  const { ticket } = await world.claimed({ priority: 'medium' });
  await svc.addNote(ticket.id, agent2, 'Team: be gentle with this customer');
  assert.equal((await world.cycle(ticket.id)).firstResponseAt, null);
  clock.set('2026-11-23 10:30');
  const { message } = await svc.replyPublic(ticket.id, agent, { body: 'Hello, looking into it' });
  const c = await world.cycle(ticket.id);
  assert.equal(fmt(c.firstResponseAt), '2026-11-23 10:30');
  assert.equal(c.firstResponseMessageId, message.id);
  assert.equal(c.replyBreachedAt, null);                              // on time
});

test('a late first reply records a reply breach exactly once', async () => {
  clock.set('2026-11-20 17:00');
  const { ticket } = await world.claimed({ priority: 'medium' });     // reply due Mon 12:30
  clock.set('2026-11-23 12:31');
  const { message: first } = await svc.replyPublic(ticket.id, agent, { body: 'Sorry for the wait' });
  clock.set('2026-11-23 13:00');
  await svc.replyPublic(ticket.id, agent, { body: 'Second message' });
  const c = await world.cycle(ticket.id);
  assert.ok(c.replyBreachedAt);
  assert.equal((await world.eventTypes(ticket.id)).filter((t) => t === 'reply_breached').length, 1);
  // The first response is the FIRST public reply. Later replies must not move it.
  assert.equal(fmt(c.firstResponseAt), '2026-11-23 12:31');
  assert.equal(c.firstResponseMessageId, first.id);
});

test('waiting: a reply with setWaiting pauses the clock and sets the auto-close time', async () => {
  clock.set('2026-11-20 17:00');
  const { ticket } = await world.claimed({ priority: 'medium' });
  clock.set('2026-11-20 17:20');
  const { ticket: after } = await svc.replyPublic(ticket.id, agent, { body: 'What is your username?', setWaiting: true });
  assert.equal(after.status, 'waiting_on_customer');
  assert.equal(fmt(after.waitingSince), '2026-11-20 17:20');
  assert.equal(fmt(after.autoCloseAt), '2026-11-27 17:20');           // 5 working days later
  const pauses = await world.pauses(ticket.id);
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].resumedAt, null);
  const types = await world.eventTypes(ticket.id);
  assert.ok(types.includes('sla_paused') && types.includes('status_changed'));
});

test('customer answers: the clock resumes and the resolve deadline moves by the waiting time', async () => {
  clock.set('2026-11-20 17:00');
  const { ticket, token } = await world.claimed({ priority: 'medium' });
  clock.set('2026-11-20 17:20');
  await svc.replyPublic(ticket.id, agent, { body: 'What is your username?', setWaiting: true });
  clock.set('2026-11-25 10:00');                                      // Wednesday
  const out = await svc.customerMessage(token, 'It is priya.k');
  assert.equal(out.outcome, 'replied');
  const t = await world.ticket(ticket.id);
  assert.equal(t.status, 'open');
  assert.equal(t.waitingSince, null);
  assert.equal(t.autoCloseAt, null);
  const [pause] = await world.pauses(ticket.id);
  assert.equal(pause.businessMinutes, 1180);                          // 70 + 540 + 540 + 30
  const c = await world.cycle(ticket.id);
  assert.equal(fmt(c.resolveDueAt), '2026-11-30 09:40');              // 1620 + 1180 minutes
  assert.equal(fmt(c.replyDueAt), '2026-11-23 12:30');                // reply deadline untouched
  const types = await world.eventTypes(ticket.id);
  for (const wanted of ['customer_replied', 'sla_resumed']) assert.ok(types.includes(wanted), wanted);
});

test('two simultaneous customer replies resume the clock only once', async () => {
  clock.set('2026-11-20 17:00');
  const { ticket, token } = await world.claimed({ priority: 'medium' });
  clock.set('2026-11-20 17:20');
  await svc.replyPublic(ticket.id, agent, { body: 'Question?', setWaiting: true });
  clock.set('2026-11-24 10:00');
  const results = await Promise.all([svc.customerMessage(token, 'answer one'), svc.customerMessage(token, 'answer two')]);
  assert.ok(results.every((r) => r.outcome === 'replied'));
  const resumed = (await world.events(ticket.id)).filter((e) => e.type === 'sla_resumed');
  assert.equal(resumed.length, 1);
  const pauses = await world.pauses(ticket.id);
  assert.equal(pauses.length, 1);
  assert.notEqual(pauses[0].businessMinutes, null);
  const customerMsgs = await db.select().from(messages).where(eq(messages.ticketId, ticket.id));
  assert.equal(customerMsgs.filter((m) => m.authorType === 'customer').length, 3);   // original + two answers
});

test('a customer message on an open ticket is just a reply (no SLA change)', async () => {
  clock.set('2026-11-23 10:00');
  const { ticket, token } = await world.claimed();
  const before = await world.cycle(ticket.id);
  const out = await svc.customerMessage(token, 'Any news?');
  assert.equal(out.outcome, 'replied');
  assert.deepEqual((await world.cycle(ticket.id)).resolveDueAt, before.resolveDueAt);
});

test('priority change: escalating keeps the original clock start and logs old and new deadlines', async () => {
  clock.set('2026-11-23 10:00');
  const { ticket } = await world.claimed({ priority: 'medium' });
  clock.set('2026-11-25 09:00');
  const updated = await svc.setPriority(ticket.id, agent, 'high');
  assert.equal(updated.priority, 'high');
  const c = await world.cycle(ticket.id);
  assert.equal(c.priority, 'high');
  assert.equal(fmt(c.replyDueAt), '2026-11-23 12:00');                // counted from the ORIGINAL start
  assert.equal(fmt(c.resolveDueAt), '2026-11-23 18:30');              // already in the past: instantly late
  const evt = (await world.events(ticket.id)).find((e) => e.type === 'priority_changed');
  assert.equal(evt.payload.from, 'medium');
  assert.equal(evt.payload.to, 'high');
  assert.ok(evt.payload.old_resolve_due_at && evt.payload.new_resolve_due_at);
});

test('priority change: downgrading never erases a recorded breach', async () => {
  clock.set('2026-11-23 10:00');
  const { ticket } = await world.claimed({ priority: 'high' });
  await db.update(slaCycles).set({ replyBreachedAt: new Date() }).where(eq(slaCycles.ticketId, ticket.id));
  await svc.setPriority(ticket.id, agent, 'low');
  assert.ok((await world.cycle(ticket.id)).replyBreachedAt);
});

test('priority change: owner or lead only, no-op when unchanged, not on resolved tickets', async () => {
  clock.set('2026-11-23 10:00');
  const { ticket } = await world.claimed({ priority: 'medium' });
  await rejectsWith(svc.setPriority(ticket.id, agent2, 'high'), 403, 'forbidden');
  await svc.setPriority(ticket.id, lead, 'low');                       // a lead may
  const events = (await world.events(ticket.id)).length;
  await svc.setPriority(ticket.id, lead, 'low');                       // unchanged: no new event
  assert.equal((await world.events(ticket.id)).length, events);
  await svc.resolveTicket(ticket.id, agent);
  await rejectsWith(svc.setPriority(ticket.id, lead, 'high'), 409, 'ticket_closed');
});

test('priority change while waiting uses only the pauses that already finished', async () => {
  clock.set('2026-11-20 17:00');
  const { ticket } = await world.claimed({ priority: 'medium' });
  clock.set('2026-11-20 17:20');
  await svc.replyPublic(ticket.id, agent, { body: 'Question?', setWaiting: true });
  await svc.setPriority(ticket.id, agent, 'low');                      // pause still open
  const c = await world.cycle(ticket.id);
  assert.equal(c.priority, 'low');
  assert.equal(fmt(c.resolveDueAt), '2026-11-27 17:00');               // 2700 min from Fri 17:00, no pause yet
});

test('resolve: starts the reopen window and ends the SLA cycle', async () => {
  clock.set('2026-11-20 17:00');
  const { ticket } = await world.claimed({ priority: 'medium' });
  clock.set('2026-11-23 11:00');
  await rejectsWith(svc.resolveTicket(ticket.id, agent2), 403, 'not_owner');
  const done = await svc.resolveTicket(ticket.id, agent);
  assert.equal(done.status, 'resolved');
  assert.equal(fmt(done.resolvedAt), '2026-11-23 11:00');
  assert.equal(fmt(done.reopenUntil), '2026-11-30 11:00');             // 5 working days
  const [c] = await world.cycles(ticket.id);
  assert.ok(c.endedAt && c.resolvedAt);
  assert.equal(c.resolveBreachedAt, null);
  await rejectsWith(svc.replyPublic(ticket.id, agent, { body: 'more' }), 409, 'ticket_closed');
});

test('resolve: a late resolve is recorded as a breach', async () => {
  clock.set('2026-11-20 17:00');
  const { ticket } = await world.claimed({ priority: 'medium' });      // resolve due Wed 17:00
  clock.set('2026-11-26 10:00');
  await svc.resolveTicket(ticket.id, agent);
  const [c] = await world.cycles(ticket.id);
  assert.ok(c.resolveBreachedAt);
  assert.ok((await world.eventTypes(ticket.id)).includes('resolve_breached'));
});

test('resolve while waiting: the pause is closed and waiting time is not held against Arvo', async () => {
  clock.set('2026-11-20 17:00');
  const { ticket } = await world.claimed({ priority: 'medium' });
  clock.set('2026-11-20 17:20');
  await svc.replyPublic(ticket.id, agent, { body: 'Question?', setWaiting: true });
  clock.set('2026-11-26 10:00');                                       // long after the original deadline
  const done = await svc.resolveTicket(ticket.id, agent);
  assert.equal(done.status, 'resolved');
  assert.equal(done.waitingSince, null);
  const [pause] = await world.pauses(ticket.id);
  assert.ok(pause.resumedAt && pause.businessMinutes > 0);
  const [c] = await world.cycles(ticket.id);
  assert.equal(c.resolveBreachedAt, null);                             // it was waiting, not late
});

test('reopen inside the window: same ticket, new SLA cycle, history kept, owner kept', async () => {
  clock.set('2026-11-20 17:00');
  const { ticket, token } = await world.claimed({ priority: 'medium' });
  clock.set('2026-11-23 11:00');
  await svc.resolveTicket(ticket.id, agent);                           // reopen until Mon 30 Nov 11:00
  clock.set('2026-11-27 10:00');
  const out = await svc.customerMessage(token, 'Still broken!');
  assert.equal(out.outcome, 'reopened');
  const t = await world.ticket(ticket.id);
  assert.equal(t.status, 'open');
  assert.equal(t.reopenCount, 1);
  assert.equal(t.resolvedAt, null);
  assert.equal(t.assigneeId, agent.id);
  const cycles = await world.cycles(ticket.id);
  assert.equal(cycles.length, 2);
  assert.equal(cycles[1].isReopen, true);
  assert.equal(fmt(cycles[1].clockStartAt), '2026-11-27 10:00');
  assert.ok(cycles[0].endedAt);                                        // the first run's record is intact
  const types = await world.eventTypes(ticket.id);
  for (const wanted of ['reopened', 'customer_replied']) assert.ok(types.includes(wanted), wanted);
});

test('reopen window boundary: allowed exactly at the deadline, a new ticket one minute later', async () => {
  clock.set('2026-11-20 17:00');
  const a = await world.claimed({ priority: 'medium' });
  clock.set('2026-11-23 11:00');
  await svc.resolveTicket(a.ticket.id, agent);
  clock.set('2026-11-30 11:00');
  assert.equal((await svc.customerMessage(a.token, 'at the deadline')).outcome, 'reopened');

  clock.set('2026-11-20 17:00');
  const b = await world.claimed({ priority: 'medium', email: 'b@example.com' });
  clock.set('2026-11-23 11:00');
  await svc.resolveTicket(b.ticket.id, agent);
  clock.set('2026-11-30 11:01');
  assert.equal((await svc.customerMessage(b.token, 'a minute too late')).outcome, 'new_ticket');
});

test('after the window: a NEW ticket linked to the old one, with its own token and SLA', async () => {
  clock.set('2026-11-20 17:00');
  const { ticket, token } = await world.claimed({ priority: 'medium', subject: 'Printer broken' });
  clock.set('2026-11-23 11:00');
  await svc.resolveTicket(ticket.id, agent);
  clock.set('2026-12-07 10:00');                                       // two weeks later
  const out = await svc.customerMessage(token, 'It happened again');
  assert.equal(out.outcome, 'new_ticket');
  assert.notEqual(out.token, token);
  assert.equal(out.ticket.parentTicketId, ticket.id);
  assert.equal(out.ticket.subject, 'Re: Printer broken');
  assert.equal(out.ticket.customerId, ticket.customerId);
  assert.equal(out.ticket.status, 'new');
  assert.ok(await world.cycle(out.ticket.id));
  assert.equal((await world.ticket(ticket.id)).status, 'resolved');    // the old ticket is not touched
  assert.ok((await world.eventTypes(ticket.id)).includes('linked_ticket_created'));
});

test('a closed ticket (e.g. auto-closed) also leads to a new linked ticket', async () => {
  clock.set('2026-11-23 10:00');
  const { ticket, token } = await world.claimed();
  await db.update(slaCycles).set({ endedAt: new Date() }).where(eq(slaCycles.ticketId, ticket.id));
  await db.update(tickets).set({ status: 'closed', closedAt: new Date(), closedReason: 'customer_no_reply' })
    .where(eq(tickets.id, ticket.id));
  const out = await svc.customerMessage(token, 'Sorry, I was away');
  assert.equal(out.outcome, 'new_ticket');
  assert.equal(out.ticket.parentTicketId, ticket.id);
});

test('an unknown token is a 404', async () => {
  await rejectsWith(svc.customerMessage('no-such-token', 'hello'), 404, 'ticket_not_found');
});

test('release: the owner or a lead can; another agent cannot', async () => {
  const { ticket } = await world.claimed();
  await rejectsWith(svc.releaseTicket(ticket.id, agent2), 403, 'forbidden');
  const freed = await svc.releaseTicket(ticket.id, agent);
  assert.equal(freed.assigneeId, null);
  assert.equal(freed.status, 'open');
  await rejectsWith(svc.releaseTicket(ticket.id, agent), 409, 'not_assigned');
  await svc.claimTicket(ticket.id, agent2);                            // claimable again
  const byLead = await svc.releaseTicket(ticket.id, lead);
  assert.equal(byLead.assigneeId, null);
  const evt = (await world.events(ticket.id)).filter((e) => e.type === 'released').at(-1);
  assert.equal(evt.payload.by_lead, true);
});

test('reassign: lead only, to an active agent', async () => {
  const { ticket } = await world.claimed();
  await rejectsWith(svc.reassignTicket(ticket.id, agent, agent2.id), 403, 'forbidden');
  const moved = await svc.reassignTicket(ticket.id, lead, agent2.id);
  assert.equal(moved.assigneeId, agent2.id);
  await rejectsWith(svc.reassignTicket(ticket.id, lead, 999999), 400, 'validation_error');
  const fresh = await world.newTicket();                               // reassigning an unclaimed ticket opens it
  const opened = await svc.reassignTicket(fresh.ticket.id, lead, agent.id);
  assert.equal(opened.status, 'open');
});

test('INC-0318: the audit trail of a whole lifecycle is complete, chained, and body-free', async () => {
  clock.set('2026-11-20 17:00');
  const { ticket, token } = await world.newTicket({ body: 'BODY-CUSTOMER-FIRST-7731' });
  await svc.claimTicket(ticket.id, agent);
  await svc.addNote(ticket.id, agent2, 'BODY-PRIVATE-NOTE-7731');
  clock.set('2026-11-20 17:20');
  await svc.replyPublic(ticket.id, agent, { body: 'BODY-AGENT-REPLY-7731', setWaiting: true });
  clock.set('2026-11-24 10:00');
  await svc.customerMessage(token, 'BODY-CUSTOMER-ANSWER-7731');
  await svc.setPriority(ticket.id, agent, 'high');
  await svc.resolveTicket(ticket.id, agent);

  const events = await world.events(ticket.id);
  const types = events.map((e) => e.type);
  for (const wanted of ['ticket_created', 'sla_cycle_started', 'claimed', 'note_added', 'public_reply_sent',
    'status_changed', 'sla_paused', 'customer_replied', 'sla_resumed', 'priority_changed', 'resolved']) {
    assert.ok(types.includes(wanted), `missing event ${wanted}`);
  }
  assert.deepEqual(events.map((e) => e.chainSeq), events.map((_, i) => i + 1));   // 1..n, no gaps

  const verify = await db.execute(sql`SELECT bool_and(ok) AS ok, count(*)::int AS n FROM verify_ticket_chain(${ticket.id})`);
  assert.equal(verify.rows[0].ok, true);
  assert.equal(verify.rows[0].n, events.length);

  // The chain must not depend on the session time zone of whoever verifies it.
  const client = await world.pool.connect();
  try {
    await client.query("SET TIME ZONE 'Asia/Tokyo'");
    const other = await client.query('SELECT bool_and(ok) AS ok FROM verify_ticket_chain($1)', [ticket.id]);
    assert.equal(other.rows[0].ok, true);
  } finally { client.release(true); }                                  // true = discard this connection

  // No message text anywhere in the log. Only ids and hashes.
  const blob = JSON.stringify(events.map((e) => e.payload));
  assert.ok(!blob.includes('7731'));
  const noteEvent = events.find((e) => e.type === 'note_added');
  assert.ok(noteEvent.messageId && noteEvent.payload.body_sha256);
});
