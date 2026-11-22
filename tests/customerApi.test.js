import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { customers, tickets } from '../db/schema.js';
import { createWorld, startServer } from './helpers/world.js';

const world = await createWorld();
const http = await startServer(world);
test.after(async () => { await http.close(); await world.drop(); });

const customer = await http.loginAs('customer@arvo.test');

async function createTicket(account = customer, overrides = {}) {
  world.clock.setMs(Date.now() + 60_000);
  const response = await account.post('/api/customer/tickets', {
    subject: 'Cannot log in',
    body: 'It says wrong password',
    priority: 'high',
    ...overrides,
  });
  assert.equal(response.status, 201);
  return response;
}

test('only an authenticated customer can create a ticket; identity comes from the session', async () => {
  const anonymous = await http.anon.post('/api/customer/tickets', {
    subject: 'Help', body: 'Please help', priority: 'high',
  });
  assert.equal(anonymous.status, 401);
  const agent = await http.loginAs('anil@arvo.test');
  assert.equal((await agent.post('/api/customer/tickets', { subject: 'Help', body: 'Please help' })).status, 403);

  const response = await createTicket(customer, {
    name: 'Ignored name',
    email: 'impersonated@example.test',
  });
  assert.deepEqual(Object.keys(response.json).sort(), ['ticket']);
  assert.deepEqual(Object.keys(response.json.ticket).sort(), ['id', 'ticketNo']);
  assert.match(response.json.ticket.ticketNo, /^FD-\d{4}$/);
  const [ticket] = await world.db.select().from(tickets).where(eq(tickets.id, response.json.ticket.id));
  const [owner] = await world.db.select().from(customers).where(eq(customers.id, ticket.customerId));
  assert.equal(owner.email, 'customer@arvo.test');
  assert.notEqual(owner.email, 'impersonated@example.test');
  assert.ok(!response.text.includes('token'));
});

test('ticket creation validates customer-entered fields and defaults priority', async () => {
  const bad = [
    { subject: '', body: 'help' },
    { subject: 'x'.repeat(201), body: 'help' },
    { subject: 'Help', body: '   ' },
    { subject: 'Help', body: 'help', priority: 'urgent' },
  ];
  for (const body of bad) {
    const response = await customer.post('/api/customer/tickets', body);
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, 'validation_error');
  }

  const response = await createTicket(customer, { priority: undefined });
  const [ticket] = await world.db.select().from(tickets)
    .where(eq(tickets.id, response.json.ticket.id));
  assert.equal(ticket.priority, 'medium');
});

test('authenticated customer list/detail shows public messages but never notes or internal fields', async () => {
  const created = await createTicket();
  const id = created.json.ticket.id;
  const anil = await http.loginAs('anil@arvo.test');
  await anil.post(`/api/agent/tickets/${id}/claim`);
  await anil.post(`/api/agent/tickets/${id}/notes`, { body: 'TEAM-ONLY-API-NOTE' });
  await anil.post(`/api/agent/tickets/${id}/replies`, { body: 'Public answer' });

  const list = await customer.get('/api/customer/tickets');
  assert.equal(list.status, 200);
  assert.ok(list.json.tickets.some((ticket) => ticket.id === id));
  assert.ok(!list.text.includes('TEAM-ONLY-API-NOTE'));

  const detail = await customer.get(`/api/customer/tickets/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.status, 'open');
  assert.equal(detail.json.messages.length, 2);
  assert.ok(detail.text.includes('Public answer'));
  assert.ok(!detail.text.includes('TEAM-ONLY-API-NOTE'));
  assert.ok(!detail.text.includes('accessTokenHash'));
  assert.ok(!detail.text.includes('customerId'));
});

test('customer tickets sort by latest public activity and show a new-reply indicator until customer reply', async () => {
  const account = await http.registerCustomer({
    name: 'Activity Customer',
    email: 'activity.customer@example.test',
    password: 'activity-test-password',
  });
  const now = Date.now();
  world.clock.setMs(now + 60_000);
  const first = await account.post('/api/customer/tickets', {
    subject: 'Older ticket',
    body: 'First request',
  });
  world.clock.setMs(now + 120_000);
  const second = await account.post('/api/customer/tickets', {
    subject: 'Newer ticket',
    body: 'Second request',
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const firstId = first.json.ticket.id;
  const secondId = second.json.ticket.id;
  const anil = await http.loginAs('anil@arvo.test');
  await anil.post(`/api/agent/tickets/${firstId}/claim`);
  world.clock.setMs(now + 180_000);
  await anil.post(`/api/agent/tickets/${firstId}/replies`, { body: 'Following up on the first request.' });

  let list = await account.get('/api/customer/tickets');
  assert.deepEqual(list.json.tickets.map((ticket) => ticket.id), [firstId, secondId]);
  assert.equal(list.json.tickets[0].hasNewReply, true);
  assert.equal(list.json.tickets[1].hasNewReply, false);
  assert.ok(Date.parse(list.json.tickets[0].lastActivityAt) > Date.parse(list.json.tickets[1].lastActivityAt));

  world.clock.setMs(now + 240_000);
  await account.post(`/api/customer/tickets/${firstId}/messages`, { body: 'Thanks for following up.' });
  list = await account.get('/api/customer/tickets');
  assert.equal(list.json.tickets[0].id, firstId);
  assert.equal(list.json.tickets[0].hasNewReply, false);
});

test('a customer cannot read, reply to, or export another account ticket by guessing its ID', async () => {
  const created = await createTicket();
  const second = await http.registerCustomer({
    name: 'Second Customer',
    email: 'second@customer.test',
    password: 'another-test-password',
  });

  for (const response of [
    await second.get(`/api/customer/tickets/${created.json.ticket.id}`),
    await second.post(`/api/customer/tickets/${created.json.ticket.id}/messages`, { body: 'Not mine' }),
    await second.get(`/api/customer/tickets/${created.json.ticket.id}/export?format=json`),
  ]) {
    assert.equal(response.status, 404);
    assert.equal(response.json.error.code, 'ticket_not_found');
  }
  const list = await second.get('/api/customer/tickets');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.tickets, []);
});

test('new accounts cannot claim pre-registration tickets by reusing an email', async () => {
  world.clock.setMs(Date.now() - 60_000);
  const legacy = await world.newTicket({
    email: 'legacy@customer.test',
    subject: 'Old ticket',
    body: 'Legacy message',
  });
  const account = await http.registerCustomer({
    name: 'Legacy Customer',
    email: 'legacy@customer.test',
    password: 'legacy-test-password',
  });

  assert.equal((await account.get('/api/customer/tickets')).json.tickets.length, 0);
  assert.equal((await account.get(`/api/customer/tickets/${legacy.ticket.id}`)).status, 404);

  const created = await createTicket(account, { subject: 'New ticket', body: 'New message' });
  const list = await account.get('/api/customer/tickets');
  assert.deepEqual(list.json.tickets.map((ticket) => ticket.id), [created.json.ticket.id]);
});

test('old private ticket token endpoints are no longer customer access paths', async () => {
  const legacy = await world.newTicket({ email: 'old-link@customer.test' });
  const account = await http.loginAs('customer@arvo.test');
  assert.equal((await account.get(`/api/customer/tickets/${legacy.token}`)).status, 404);
  assert.equal((await account.post(`/api/customer/tickets/${legacy.token}/messages`, { body: 'Reply' })).status, 404);
  assert.equal((await http.anon.get(`/api/customer/tickets/${legacy.token}`)).status, 401);
});

test('a customer reply resumes waiting tickets and the response exposes no message text', async () => {
  const created = await createTicket();
  const id = created.json.ticket.id;
  const anil = await http.loginAs('anil@arvo.test');
  await anil.post(`/api/agent/tickets/${id}/claim`);
  await anil.post(`/api/agent/tickets/${id}/replies`, {
    body: 'What is your username?',
    setWaiting: true,
  });

  const waiting = await customer.get(`/api/customer/tickets/${id}`);
  assert.equal(waiting.json.status, 'waiting_on_customer');
  assert.equal(waiting.json.messages.length, 2);
  const response = await customer.post(`/api/customer/tickets/${id}/messages`, { body: 'priya.k' });
  assert.equal(response.status, 201);
  assert.equal(response.json.outcome, 'replied');
  assert.ok(!response.text.includes('priya.k'));
  const reopened = await customer.get(`/api/customer/tickets/${id}`);
  assert.equal(reopened.json.status, 'open');
  assert.equal(reopened.json.messages.length, 3);
});

test('customer replies reopen within the window and create an authenticated linked ticket after it', async () => {
  const created = await createTicket();
  const id = created.json.ticket.id;
  const anil = await http.loginAs('anil@arvo.test');
  await anil.post(`/api/agent/tickets/${id}/claim`);
  world.clock.setMs(Date.now() + 120_000);
  await anil.post(`/api/agent/tickets/${id}/resolve`);

  const canReopen = await customer.get(`/api/customer/tickets/${id}`);
  assert.equal(canReopen.json.canReopen, true);
  const reopened = await customer.post(`/api/customer/tickets/${id}/messages`, { body: 'Still broken' });
  assert.equal(reopened.json.outcome, 'reopened');
  assert.equal((await customer.get(`/api/customer/tickets/${id}`)).json.status, 'open');

  await anil.post(`/api/agent/tickets/${id}/resolve`);
  const [resolved] = await world.db.select().from(tickets).where(eq(tickets.id, id));
  world.clock.setMs(resolved.reopenUntil.getTime() + 60_000);
  const linked = await customer.post(`/api/customer/tickets/${id}/messages`, { body: 'It happened again' });
  assert.equal(linked.status, 201);
  assert.equal(linked.json.outcome, 'new_ticket');
  assert.ok(linked.json.ticketId);
  assert.ok(!linked.text.includes('token') && !linked.text.includes('link'));
  const linkedTicket = await customer.get(`/api/customer/tickets/${linked.json.ticketId}`);
  assert.equal(linkedTicket.json.subject, 'Re: Cannot log in');
});

test('customer message validation, role separation, and ticket-not-found behavior', async () => {
  const created = await createTicket();
  for (const body of [undefined, '', '  ', 'x'.repeat(10_001)]) {
    const response = await customer.post(`/api/customer/tickets/${created.json.ticket.id}/messages`, { body });
    assert.equal(response.status, 400);
  }
  const agent = await http.loginAs('anil@arvo.test');
  assert.equal((await agent.get('/api/customer/tickets')).status, 403);
  assert.equal((await http.anon.get('/api/customer/tickets')).status, 401);
  assert.equal((await customer.get('/api/customer/tickets/999999')).status, 404);
  assert.equal((await http.anon.get('/api/agent/tickets/1')).status, 401);
});
