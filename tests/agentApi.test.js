import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, startServer } from './helpers/world.js';

const world = await createWorld();
const http = await startServer(world);
test.after(async () => { await http.close(); await world.drop(); });

const DAY = 86_400_000;
const create = (body) => http.anon.post('/api/customer/tickets', {
  name: 'Cust', email: 'c@example.com', subject: 'Help', body: 'Please help', priority: 'high', ...body,
});

test('every agent route needs a session', async () => {
  for (const [method, path] of [['GET', '/api/agent/tickets'], ['GET', '/api/agent/tickets/1'],
    ['POST', '/api/agent/tickets/1/claim'], ['POST', '/api/agent/tickets/1/replies'],
    ['POST', '/api/agent/tickets/1/notes'], ['PATCH', '/api/agent/tickets/1/priority'],
    ['POST', '/api/agent/tickets/1/resolve'], ['GET', '/api/agent/users']]) {
    const res = await http.call(method, path, { body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('claim over HTTP: two agents at once, one 200 and one 409', async () => {
  world.clock.set('2026-11-23 10:00');
  const { json } = await create({});
  const id = (await world.db.query.tickets.findFirst({ orderBy: (t, { desc }) => desc(t.id) })).id;
  const [anil, priya] = await Promise.all([http.loginAs('anil@arvo.test'), http.loginAs('priya@arvo.test')]);
  const [a, b] = await Promise.all([anil.post(`/api/agent/tickets/${id}/claim`), priya.post(`/api/agent/tickets/${id}/claim`)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.json.error.code, 'already_claimed');
  assert.ok(json.token);
});

test('ticket list: flags, mine, sorting and NO message text', async () => {
  const anil = await http.loginAs('anil@arvo.test');
  // A ticket whose deadlines are long past (late) and one far in the future (not late).
  world.clock.setMs(Date.now() - 30 * DAY);
  await create({ subject: 'OLD-AND-LATE', body: 'BODY-OLD-1234' });
  world.clock.setMs(Date.now() + 30 * DAY);
  await create({ subject: 'FUTURE', body: 'BODY-FUTURE-1234' });

  const all = await anil.get('/api/agent/tickets?view=all');
  assert.equal(all.status, 200);
  assert.ok(!all.text.includes('BODY-'));                              // list never selects message text
  assert.ok(!all.text.includes('"body"'));
  const old = all.json.tickets.find((t) => t.subject === 'OLD-AND-LATE');
  const future = all.json.tickets.find((t) => t.subject === 'FUTURE');
  assert.equal(old.isLate, true);
  assert.equal(old.replyLate, true);
  assert.equal(future.isLate, false);
  assert.equal(old.isUnclaimed, true);
  assert.match(old.ticketNo, /^FD-\d{4}$/);
  assert.match(old.createdAt, /Z$/);                                   // ISO UTC

  const late = await anil.get('/api/agent/tickets?view=late');
  assert.ok(late.json.tickets.some((t) => t.subject === 'OLD-AND-LATE'));
  assert.ok(!late.json.tickets.some((t) => t.subject === 'FUTURE'));
  assert.equal(all.json.tickets.findIndex((t) => t.isLate) < all.json.tickets.findIndex((t) => !t.isLate), true);   // late first

  const unclaimed = await anil.get('/api/agent/tickets?view=unclaimed');
  assert.ok(unclaimed.json.tickets.every((t) => t.isUnclaimed));
});

test('ticket list: mine and waiting views', async () => {
  world.clock.set('2026-11-23 10:00');
  const anil = await http.loginAs('anil@arvo.test');
  await create({ subject: 'WAITING-ONE', email: 'w@example.com' });
  const id = (await world.db.query.tickets.findFirst({ orderBy: (t, { desc }) => desc(t.id) })).id;
  assert.equal((await anil.post(`/api/agent/tickets/${id}/claim`)).status, 200);
  let mine = await anil.get('/api/agent/tickets?view=mine');
  assert.ok(mine.json.tickets.find((t) => t.id === id)?.isMine);
  assert.equal((await anil.post(`/api/agent/tickets/${id}/replies`, { body: 'Question?', setWaiting: true })).status, 201);
  const waiting = await anil.get('/api/agent/tickets?view=waiting');
  const row = waiting.json.tickets.find((t) => t.id === id);
  assert.equal(row.isWaiting, true);
  assert.equal(row.status, 'waiting_on_customer');
  assert.equal(row.nextDueAt, null);                                   // the clock is stopped
  const priya = await http.loginAs('priya@arvo.test');
  mine = await priya.get('/api/agent/tickets?view=mine');
  assert.ok(!mine.json.tickets.some((t) => t.id === id));
});

test('list view parameter is validated', async () => {
  const anil = await http.loginAs('anil@arvo.test');
  const res = await anil.get('/api/agent/tickets?view=bogus');
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'validation_error');
});

test('ticket detail shows the full thread, including team notes, plus events and SLA', async () => {
  world.clock.set('2026-11-23 10:00');
  const anil = await http.loginAs('anil@arvo.test');
  await create({ subject: 'DETAIL', body: 'PUBLIC-FIRST', email: 'd@example.com' });
  const id = (await world.db.query.tickets.findFirst({ orderBy: (t, { desc }) => desc(t.id) })).id;
  await anil.post(`/api/agent/tickets/${id}/claim`);
  assert.equal((await anil.post(`/api/agent/tickets/${id}/notes`, { body: 'NOTE-TEAM-ONLY' })).status, 201);
  await anil.post(`/api/agent/tickets/${id}/replies`, { body: 'PUBLIC-REPLY' });
  const detail = await anil.get(`/api/agent/tickets/${id}`);
  assert.equal(detail.status, 200);
  const kinds = detail.json.messages.map((m) => [m.kind, m.body]);
  assert.deepEqual(kinds, [['public', 'PUBLIC-FIRST'], ['note', 'NOTE-TEAM-ONLY'], ['public', 'PUBLIC-REPLY']]);
  assert.equal(detail.json.messages[1].authorName, 'Anil Kumar');
  assert.ok(detail.json.events.length >= 5);
  assert.equal(detail.json.sla.cycles[0].cycleNo, 1);
  assert.ok(!detail.text.includes('accessTokenHash'));
  assert.ok(!detail.text.includes('password'));
});

test('ids: unknown or malformed ids are 404', async () => {
  const anil = await http.loginAs('anil@arvo.test');
  assert.equal((await anil.get('/api/agent/tickets/999999')).status, 404);
  assert.equal((await anil.get('/api/agent/tickets/abc')).status, 404);
  assert.equal((await anil.get('/api/agent/tickets/-1')).status, 404);
});

test('reply and note bodies are validated', async () => {
  world.clock.set('2026-11-23 10:00');
  const anil = await http.loginAs('anil@arvo.test');
  await create({ email: 'v@example.com' });
  const id = (await world.db.query.tickets.findFirst({ orderBy: (t, { desc }) => desc(t.id) })).id;
  await anil.post(`/api/agent/tickets/${id}/claim`);
  for (const body of [undefined, '', '   ', 42, 'x'.repeat(10_001)]) {
    const reply = await anil.post(`/api/agent/tickets/${id}/replies`, { body });
    assert.equal(reply.status, 400, `reply body=${String(body).slice(0, 10)}`);
    assert.equal(reply.json.error.code, 'validation_error');
    assert.equal((await anil.post(`/api/agent/tickets/${id}/notes`, { body })).status, 400);
  }
  const bad = await anil.post(`/api/agent/tickets/${id}/replies`, { body: 'ok', setWaiting: 'yes' });
  assert.equal(bad.status, 400);
});

test('a non-owner reply is a 403 with a clear code', async () => {
  world.clock.set('2026-11-23 10:00');
  await create({ email: 'o@example.com' });
  const id = (await world.db.query.tickets.findFirst({ orderBy: (t, { desc }) => desc(t.id) })).id;
  const anil = await http.loginAs('anil@arvo.test');
  const priya = await http.loginAs('priya@arvo.test');
  await anil.post(`/api/agent/tickets/${id}/claim`);
  const res = await priya.post(`/api/agent/tickets/${id}/replies`, { body: 'I will answer this' });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'not_owner');
});

test('priority and resolve over HTTP', async () => {
  world.clock.set('2026-11-23 10:00');
  await create({ email: 'p@example.com', priority: 'low' });
  const id = (await world.db.query.tickets.findFirst({ orderBy: (t, { desc }) => desc(t.id) })).id;
  const anil = await http.loginAs('anil@arvo.test');
  await anil.post(`/api/agent/tickets/${id}/claim`);
  const bad = await anil.patch(`/api/agent/tickets/${id}/priority`, { priority: 'urgent' });
  assert.equal(bad.status, 400);
  const up = await anil.patch(`/api/agent/tickets/${id}/priority`, { priority: 'high' });
  assert.equal(up.status, 200);
  assert.equal(up.json.ticket.priority, 'high');
  const done = await anil.post(`/api/agent/tickets/${id}/resolve`);
  assert.equal(done.status, 200);
  assert.equal(done.json.ticket.status, 'resolved');
});

test('users list and reassign are lead-only', async () => {
  const anil = await http.loginAs('anil@arvo.test');
  const meera = await http.loginAs('meera@arvo.test');
  assert.equal((await anil.get('/api/agent/users')).status, 403);
  const list = await meera.get('/api/agent/users');
  assert.equal(list.status, 200);
  assert.equal(list.json.users.length, 10);
  assert.ok(!list.text.includes('password') && !list.text.includes('$2'));
  world.clock.set('2026-11-23 10:00');
  await create({ email: 'r@example.com' });
  const id = (await world.db.query.tickets.findFirst({ orderBy: (t, { desc }) => desc(t.id) })).id;
  const target = list.json.users.find((u) => u.name === 'Priya Menon');
  assert.equal((await anil.post(`/api/agent/tickets/${id}/reassign`, { userId: target.id })).status, 403);
  const moved = await meera.post(`/api/agent/tickets/${id}/reassign`, { userId: target.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.ticket.assigneeId, target.id);
});
