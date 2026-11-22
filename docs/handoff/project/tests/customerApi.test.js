import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { customers, tickets } from '../db/schema.js';
import { sha, createWorld, startServer } from './helpers/world.js';

const world = await createWorld();
const http = await startServer(world);
test.after(async () => { await http.close(); await world.drop(); });

const valid = { name: 'Priya', email: 'priya@customer.test', subject: 'Cannot log in', body: 'It says wrong password', priority: 'high' };

test('raising a ticket returns a secret link once, and only the hash is stored', async () => {
  world.clock.set('2026-11-20 18:00');
  const res = await http.anon.post('/api/customer/tickets', valid);
  assert.equal(res.status, 201);
  assert.ok(res.json.token.length >= 30);
  assert.equal(res.json.link, `/t/${res.json.token}`);
  assert.match(res.json.ticket.ticketNo, /^FD-\d{4}$/);
  const [row] = await world.db.select().from(tickets).where(sql`${tickets.accessTokenHash} = ${sha(res.json.token)}`);
  assert.ok(row);
  const dump = JSON.stringify(await world.db.select().from(tickets));
  assert.ok(!dump.includes(res.json.token));                           // the raw token is nowhere in the database
});

test('raising a ticket validates every field', async () => {
  const bad = [
    { ...valid, name: '' }, { ...valid, email: 'nope' }, { ...valid, email: undefined },
    { ...valid, subject: 'x'.repeat(201) }, { ...valid, body: '   ' }, { ...valid, priority: 'urgent' },
  ];
  for (const body of bad) {
    const res = await http.anon.post('/api/customer/tickets', body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(res.json.error.code, 'validation_error');
  }
});

test('priority defaults to medium when the customer does not choose', async () => {
  const res = await http.anon.post('/api/customer/tickets', { ...valid, email: 'd@customer.test', priority: undefined });
  assert.equal(res.status, 201);
  const [row] = await world.db.select().from(tickets).where(sql`${tickets.accessTokenHash} = ${sha(res.json.token)}`);
  assert.equal(row.priority, 'medium');
});

test('the same email in different cases is one customer', async () => {
  await http.anon.post('/api/customer/tickets', { ...valid, email: 'Mixed@Customer.Test' });
  await http.anon.post('/api/customer/tickets', { ...valid, email: 'mixed@customer.test' });
  const rows = await world.db.select().from(customers).where(sql`lower(${customers.email}) = 'mixed@customer.test'`);
  assert.equal(rows.length, 1);
});

test('the customer view shows the public thread and the status', async () => {
  const created = await http.anon.post('/api/customer/tickets', { ...valid, email: 'v@customer.test' });
  const view = await http.anon.get(`/api/customer/tickets/${created.json.token}`);
  assert.equal(view.status, 200);
  assert.equal(view.json.status, 'new');
  assert.equal(view.json.subject, 'Cannot log in');
  assert.equal(view.json.messages.length, 1);
  assert.equal(view.json.messages[0].body, 'It says wrong password');
  assert.equal(view.json.messages[0].authorType, 'customer');
  assert.equal(view.json.canReopen, false);
});

test('an unknown or malformed token is the same 404 and says nothing else', async () => {
  const a = await http.anon.get('/api/customer/tickets/this-token-does-not-exist-123456');
  const b = await http.anon.get('/api/customer/tickets/x');
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.deepEqual(a.json, b.json);
  assert.equal(a.json.error.code, 'ticket_not_found');
});

test('the customer can reply, and sees "waiting" while an agent is waiting on them', async () => {
  world.clock.set('2026-11-23 10:00');
  const created = await http.anon.post('/api/customer/tickets', { ...valid, email: 'w@customer.test' });
  const id = (await world.db.select().from(tickets).where(sql`${tickets.accessTokenHash} = ${sha(created.json.token)}`))[0].id;
  const anil = await http.loginAs('anil@arvo.test');
  await anil.post(`/api/agent/tickets/${id}/claim`);
  await anil.post(`/api/agent/tickets/${id}/replies`, { body: 'What is your username?', setWaiting: true });
  let view = await http.anon.get(`/api/customer/tickets/${created.json.token}`);
  assert.equal(view.json.status, 'waiting_on_customer');
  assert.equal(view.json.messages.length, 2);
  const reply = await http.anon.post(`/api/customer/tickets/${created.json.token}/messages`, { body: 'priya.k' });
  assert.equal(reply.status, 201);
  assert.equal(reply.json.outcome, 'replied');
  view = await http.anon.get(`/api/customer/tickets/${created.json.token}`);
  assert.equal(view.json.status, 'open');
  assert.equal(view.json.messages.length, 3);
});

test('reopen flow over HTTP: canReopen while the window is open, new linked ticket after', async () => {
  world.clock.set('2026-11-20 17:00');
  const created = await http.anon.post('/api/customer/tickets', { ...valid, email: 'r@customer.test', priority: 'medium' });
  const id = (await world.db.select().from(tickets).where(sql`${tickets.accessTokenHash} = ${sha(created.json.token)}`))[0].id;
  const anil = await http.loginAs('anil@arvo.test');
  await anil.post(`/api/agent/tickets/${id}/claim`);
  world.clock.set('2026-11-23 11:00');
  await anil.post(`/api/agent/tickets/${id}/resolve`);

  world.clock.set('2026-11-24 09:00');
  let view = await http.anon.get(`/api/customer/tickets/${created.json.token}`);
  assert.equal(view.json.status, 'resolved');
  assert.equal(view.json.canReopen, true);

  world.clock.set('2026-12-10 09:00');
  view = await http.anon.get(`/api/customer/tickets/${created.json.token}`);
  assert.equal(view.json.canReopen, false);
  const again = await http.anon.post(`/api/customer/tickets/${created.json.token}/messages`, { body: 'It is back' });
  assert.equal(again.status, 201);
  assert.equal(again.json.outcome, 'new_ticket');
  assert.ok(again.json.token && again.json.token !== created.json.token);   // the new ticket's own link
  const next = await http.anon.get(`/api/customer/tickets/${again.json.token}`);
  assert.equal(next.json.subject, 'Re: Cannot log in');
});

test('customer message validation', async () => {
  const created = await http.anon.post('/api/customer/tickets', { ...valid, email: 'm@customer.test' });
  for (const body of [undefined, '', '  ', 'x'.repeat(10_001)]) {
    const res = await http.anon.post(`/api/customer/tickets/${created.json.token}/messages`, { body });
    assert.equal(res.status, 400);
  }
});

test('customers cannot reach agent routes or other customers by guessing ids', async () => {
  assert.equal((await http.anon.get('/api/agent/tickets/1')).status, 401);
  assert.equal((await http.anon.get('/api/customer/tickets/1')).status, 404);
});
