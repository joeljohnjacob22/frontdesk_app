import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createDb, createPool } from '../db/client.js';
import { sha, createWorld, startServer } from './helpers/world.js';

// INC-0304: a private team note must never reach a customer. "Not on a screen. Not in an API response.
// Not in an export. Not in a list." This file proves it for every customer-facing path that exists.
const NOTE = 'SECRET-NOTE-9f3a1c';
const PUBLIC_REPLY = 'PUBLIC-REPLY-5b2e77';

const world = await createWorld();
const http = await startServer(world);
test.after(async () => { await http.close(); await world.drop(); });

// Every key name that must never appear anywhere in a customer-facing JSON document.
const FORBIDDEN_KEYS = ['kind', 'priority', 'assignee', 'assigneeId', 'accessTokenHash', 'passwordHash', 'email',
  'customerId', 'authorUserId', 'recipientUserId', 'sla', 'events', 'payload', 'cycles', 'chainSeq'];
function allKeys(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.add(k); allKeys(v, out); }
  }
  return out;
}

// One ticket, one customer, one private note, one public agent reply.
async function scenario() {
  world.clock.set('2026-11-23 10:00');
  const created = await http.anon.post('/api/customer/tickets', {
    name: 'Priya', email: 'priya@customer.test', subject: 'Difficult customer', body: 'I need help now', priority: 'high',
  });
  const token = created.json.token;
  const [{ id }] = (await world.db.execute(sql`select id from tickets where access_token_hash = ${sha(token)}`)).rows;
  const anil = await http.loginAs('anil@arvo.test');
  const priya = await http.loginAs('priya@arvo.test');
  await anil.post(`/api/agent/tickets/${id}/claim`);
  assert.equal((await priya.post(`/api/agent/tickets/${id}/notes`, { body: NOTE })).status, 201);   // another agent's note
  assert.equal((await anil.post(`/api/agent/tickets/${id}/replies`, { body: PUBLIC_REPLY })).status, 201);
  return { token, id, anil, created };
}

test('POSITIVE CONTROL: the agent can see the note (so the leak tests below cannot pass vacuously)', async () => {
  const { id, anil } = await scenario();
  const detail = await anil.get(`/api/agent/tickets/${id}`);
  assert.ok(detail.text.includes(NOTE));
  assert.equal(detail.json.messages.find((m) => m.body === NOTE).kind, 'note');
});

test('the customer ticket view never contains the note, and exposes no internal fields', async () => {
  const { token } = await scenario();
  const view = await http.anon.get(`/api/customer/tickets/${token}`);
  assert.equal(view.status, 200);
  assert.ok(view.text.includes(PUBLIC_REPLY));                         // the public reply IS there
  assert.ok(!view.text.includes(NOTE));
  assert.equal(view.json.messages.length, 2);                          // customer's first message + public reply
  const keys = allKeys(view.json);
  for (const forbidden of FORBIDDEN_KEYS) assert.ok(!keys.has(forbidden), `customer view leaks key "${forbidden}"`);
});

test('customer write responses contain no message text and no note', async () => {
  const { token } = await scenario();
  const reply = await http.anon.post(`/api/customer/tickets/${token}/messages`, { body: 'Thanks, one more thing' });
  assert.equal(reply.status, 201);
  assert.ok(!reply.text.includes(NOTE));
  assert.ok(!reply.text.includes(PUBLIC_REPLY));
  assert.deepEqual(Object.keys(reply.json).sort(), ['outcome', 'ticketNo']);
  const created = await http.anon.post('/api/customer/tickets', {
    name: 'X', email: 'x@customer.test', subject: 'S', body: 'B',
  });
  assert.deepEqual(Object.keys(created.json).sort(), ['link', 'ticket', 'token']);
});

test('the agent ticket LIST has no message text at all (no previews, snippets or last-message fields)', async () => {
  const { anil } = await scenario();
  for (const view of ['open', 'all', 'mine', 'unclaimed', 'waiting', 'late', 'resolved']) {
    const res = await anil.get(`/api/agent/tickets?view=${view}`);
    assert.equal(res.status, 200, view);
    assert.ok(!res.text.includes(NOTE), `list "${view}" leaks the note`);
    assert.ok(!res.text.includes(PUBLIC_REPLY), `list "${view}" contains message text`);
    const keys = allKeys(res.json);
    for (const k of ['body', 'message', 'messages', 'preview', 'snippet', 'lastMessage']) {
      assert.ok(!keys.has(k), `list "${view}" has key "${k}"`);
    }
  }
});

test('error responses leak nothing', async () => {
  const { token } = await scenario();
  const responses = [
    await http.anon.get('/api/customer/tickets/wrong-token-wrong-token-wrong'),
    await http.anon.post(`/api/customer/tickets/${token}/messages`, { body: '' }),
    await http.anon.get('/api/agent/tickets'),                         // unauthenticated
  ];
  for (const r of responses) {
    assert.ok(!r.text.includes(NOTE));
    assert.ok(!r.text.includes('SELECT') && !r.text.includes('select '));   // no SQL
    assert.ok(!r.text.includes('node_modules'));                        // no stack trace
  }
});

test('the audit events never contain note text (they are agent-only, but must still be body-free)', async () => {
  const { id, anil } = await scenario();
  const detail = await anil.get(`/api/agent/tickets/${id}`);
  const eventsJson = JSON.stringify(detail.json.events);
  assert.ok(!eventsJson.includes(NOTE));
  assert.ok(!eventsJson.includes(PUBLIC_REPLY));
});

// ---- Defence in depth: run every customer READ through a DB role that can only see the two views ----
const roleExists = (await world.pool.query(
  `SELECT 1 FROM pg_roles WHERE rolname = 'frontdesk_customer_reader'`)).rowCount === 1;

// A pool whose every connection starts as the view-only role (a startup option, so it applies before any query).
const restrictedPool = () => createPool(world.url, { max: 2, options: '-c role=frontdesk_customer_reader' });

test('restricted DB role: it can read the customer views but not the tables', { skip: !roleExists && 'role not created' }, async () => {
  const pool = restrictedPool();
  try {
    await assert.rejects(pool.query('SELECT * FROM messages'), /permission denied/);
    await assert.rejects(pool.query('SELECT * FROM ticket_events'), /permission denied/);
    await assert.rejects(pool.query('SELECT * FROM users'), /permission denied/);
    await assert.rejects(pool.query('SELECT * FROM tickets'), /permission denied/);
    assert.equal((await pool.query('SELECT * FROM customer_messages')).rows.every((r) => r.body !== NOTE), true);
  } finally { await pool.end(); }
});

test('with the restricted role as the customer connection, the customer view still works and still has no note', { skip: !roleExists && 'role not created' }, async () => {
  const pool = restrictedPool();
  const restricted = await startServer(world, { customerDb: createDb(pool) });
  try {
    const created = await restricted.anon.post('/api/customer/tickets', {
      name: 'R', email: 'r@customer.test', subject: 'Role test', body: 'hello', priority: 'low',
    });
    const [{ id }] = (await world.db.execute(sql`select id from tickets where access_token_hash = ${sha(created.json.token)}`)).rows;
    const anil = await restricted.loginAs('anil@arvo.test');
    await anil.post(`/api/agent/tickets/${id}/claim`);
    await anil.post(`/api/agent/tickets/${id}/notes`, { body: NOTE });
    await anil.post(`/api/agent/tickets/${id}/replies`, { body: PUBLIC_REPLY });
    const view = await restricted.anon.get(`/api/customer/tickets/${created.json.token}`);
    assert.equal(view.status, 200);                                     // if any query touched a table, this would be a 500
    assert.ok(view.text.includes(PUBLIC_REPLY));
    assert.ok(!view.text.includes(NOTE));
  } finally { await restricted.close(); await pool.end(); }
});
