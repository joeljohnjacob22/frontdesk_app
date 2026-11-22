import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { ticketEvents, tickets } from '../db/schema.js';
import { createDb, createPool } from '../db/client.js';
import { createWorld, startServer } from './helpers/world.js';
import { sha } from './helpers/world.js';

const world = await createWorld();
const http = await startServer(world);
test.after(async () => { await http.close(); await world.drop(); });

async function createTicket({ subject = 'Export ticket', body = 'Public message', email = 'export@example.test' } = {}) {
  world.clock.set('2026-11-23 10:00');
  const created = await http.anon.post('/api/customer/tickets', {
    name: 'Export Customer',
    email,
    subject,
    body,
    priority: 'medium',
  });
  assert.equal(created.status, 201);
  const [ticket] = await world.db.select().from(tickets)
    .where(eq(tickets.accessTokenHash, sha(created.json.token)));
  return { token: created.json.token, ticket };
}

test('agent JSON export omits notes by default and logs the export', async () => {
  const { ticket } = await createTicket();
  const anil = await http.loginAs('anil@arvo.test');
  await anil.post(`/api/agent/tickets/${ticket.id}/claim`);
  await anil.post(`/api/agent/tickets/${ticket.id}/notes`, { body: 'PRIVATE-EXPORT-NOTE' });

  const response = await anil.get(`/api/agent/tickets/${ticket.id}/export?format=json`);
  assert.equal(response.status, 200);
  assert.ok(!response.text.includes('PRIVATE-EXPORT-NOTE'));
  assert.ok(!response.text.includes('accessTokenHash'));
  assert.equal(response.json.messages.length, 1);

  const events = await world.db.select().from(ticketEvents)
    .where(eq(ticketEvents.ticketId, ticket.id));
  const exported = events.filter((event) => event.type === 'export_generated');
  assert.equal(exported.length, 1);
  assert.deepEqual(exported[0].payload, { format: 'json', include_notes: false });
  assert.ok(!JSON.stringify(exported[0].payload).includes('PRIVATE-EXPORT-NOTE'));
});

test('agent can explicitly include private notes in an export', async () => {
  const { ticket } = await createTicket({ email: 'export-notes@example.test' });
  const anil = await http.loginAs('anil@arvo.test');
  await anil.post(`/api/agent/tickets/${ticket.id}/claim`);
  await anil.post(`/api/agent/tickets/${ticket.id}/notes`, { body: 'PRIVATE-EXPORT-OPT-IN' });

  const response = await anil.get(`/api/agent/tickets/${ticket.id}/export?format=json&include_notes=true`);
  assert.equal(response.status, 200);
  const note = response.json.messages.find((message) => message.kind === 'note');
  assert.equal(note.body, 'PRIVATE-EXPORT-OPT-IN');
});

test('customer JSON export is limited to public view fields and messages', async () => {
  const { token, ticket } = await createTicket({ email: 'customer-export@example.test' });
  const anil = await http.loginAs('anil@arvo.test');
  await anil.post(`/api/agent/tickets/${ticket.id}/claim`);
  await anil.post(`/api/agent/tickets/${ticket.id}/notes`, { body: 'CUSTOMER-EXPORT-PRIVATE' });
  await anil.post(`/api/agent/tickets/${ticket.id}/replies`, { body: 'CUSTOMER-EXPORT-PUBLIC' });

  const response = await http.anon.get(`/api/customer/tickets/${token}/export?format=json`);
  assert.equal(response.status, 200);
  assert.ok(response.text.includes('CUSTOMER-EXPORT-PUBLIC'));
  assert.ok(!response.text.includes('CUSTOMER-EXPORT-PRIVATE'));
  assert.deepEqual(Object.keys(response.json).sort(), [
    'closedAt', 'createdAt', 'messages', 'reopenUntil', 'resolvedAt', 'status', 'subject', 'ticketNo',
  ]);
  assert.ok(response.json.messages.every((message) => !Object.hasOwn(message, 'kind')));
  const events = await world.db.select().from(ticketEvents)
    .where(eq(ticketEvents.ticketId, ticket.id));
  assert.ok(events.some((event) => event.type === 'export_generated'
    && event.actorType === 'customer'
    && event.payload.format === 'json'
    && event.payload.include_notes === false));
});

test('CSV export escapes fields and neutralizes spreadsheet formulas', async () => {
  const { token, ticket } = await createTicket({
    subject: '=HYPERLINK("https://bad.example","click")',
    body: '+SUM(A1,A2)',
    email: 'csv-export@example.test',
  });
  await world.db.update(tickets)
    .set({ subject: '\f\t=HYPERLINK("https://bad.example","tab")' })
    .where(eq(tickets.id, ticket.id));
  const anil = await http.loginAs('anil@arvo.test');
  await anil.post(`/api/agent/tickets/${ticket.id}/claim`);

  const response = await http.anon.get(`/api/customer/tickets/${token}/export?format=csv`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  assert.match(response.headers.get('content-disposition'), /attachment; filename=/);
  assert.ok(response.text.includes(`'\f\t=HYPERLINK(""https://bad.example"",""tab"")`));
  assert.ok(response.text.includes("'+SUM(A1,A2)"));
});

test('export format and include_notes values are validated', async () => {
  const { ticket } = await createTicket({ email: 'export-validation@example.test' });
  const anil = await http.loginAs('anil@arvo.test');
  assert.equal((await anil.get(`/api/agent/tickets/${ticket.id}/export?format=pdf`)).status, 400);
  assert.equal((await anil.get(`/api/agent/tickets/${ticket.id}/export?include_notes=maybe`)).status, 400);
});

test('restricted customer database can export through only customer views', async () => {
  const { token } = await createTicket({ email: 'restricted-export@example.test' });
  const pool = createPool(world.url, { max: 2, options: '-c role=frontdesk_customer_reader' });
  const restricted = await startServer(world, { customerDb: createDb(pool) });
  try {
    const response = await restricted.anon.get(`/api/customer/tickets/${token}/export?format=json`);
    assert.equal(response.status, 200);
    assert.equal(response.json.messages.length, 1);
    assert.ok(!response.text.includes('accessTokenHash'));
  } finally {
    await restricted.close();
    await pool.end();
  }
});
