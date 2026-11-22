import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { SESSION_COOKIE, signSession, verifySession } from '../server/lib/session.js';
import { PASSWORD, createWorld, startServer } from './helpers/world.js';

const world = await createWorld();
const http = await startServer(world);
test.after(async () => { await http.close(); await world.drop(); });

test('login sets an HttpOnly, SameSite session cookie and returns the user without secrets', async () => {
  const res = await http.call('POST', '/api/auth/login', { body: { email: 'anil@arvo.test', password: PASSWORD } });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json.user).sort(), ['email', 'id', 'name', 'passwordChangeRequired', 'role']);
  assert.equal(res.json.user.role, 'agent');
  assert.equal(res.json.user.passwordChangeRequired, false);
  assert.ok(!res.text.includes('passwordHash') && !res.text.includes('$2'));   // no bcrypt hash anywhere
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

test('email is case-insensitive', async () => {
  const res = await http.call('POST', '/api/auth/login', { body: { email: 'ANIL@Arvo.Test', password: PASSWORD } });
  assert.equal(res.status, 200);
});

test('wrong password and unknown email get the identical 401', async () => {
  const wrong = await http.call('POST', '/api/auth/login', { body: { email: 'anil@arvo.test', password: 'nope' } });
  const unknown = await http.call('POST', '/api/auth/login', { body: { email: 'ghost@arvo.test', password: 'nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.json, unknown.json);
  assert.equal(wrong.json.error.code, 'invalid_credentials');
});

test('login validates its input', async () => {
  const res = await http.call('POST', '/api/auth/login', { body: { email: 'not-an-email', password: 'x' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'validation_error');
});

test('/me needs a session; agent routes answer 401 without one', async () => {
  assert.equal((await http.anon.get('/api/auth/me')).status, 401);
  const list = await http.anon.get('/api/agent/tickets');
  assert.equal(list.status, 401);
  assert.equal(list.json.error.code, 'unauthenticated');
});

test('a signed-in agent can read /me', async () => {
  const anil = await http.loginAs('anil@arvo.test');
  const me = await anil.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, 'anil@arvo.test');
});

test('customers can register but cannot choose another role', async () => {
  const res = await http.call('POST', '/api/auth/register', {
    body: {
      name: 'New Customer',
      email: 'new.customer@example.test',
      password: 'a-valid-test-password',
      role: 'lead',
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.user.role, 'customer');
  assert.equal(res.json.user.passwordChangeRequired, false);
  assert.ok(!res.text.includes('passwordHash') && !res.text.includes('$2'));
  assert.match(res.headers.getSetCookie()[0], /HttpOnly/);

  const duplicate = await http.call('POST', '/api/auth/register', {
    body: { name: 'Duplicate', email: 'NEW.CUSTOMER@example.test', password: 'a-valid-test-password' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, 'email_in_use');
});

test('customer registration validates fields and password length', async () => {
  for (const body of [
    { name: '', email: 'new@example.test', password: 'a-valid-test-password' },
    { name: 'New Customer', email: 'not-an-email', password: 'a-valid-test-password' },
    { name: 'New Customer', email: 'new@example.test', password: 'short' },
  ]) {
    const response = await http.anon.post('/api/auth/register', body);
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, 'validation_error');
  }
});

test('role guards keep customers and staff out of each other’s API areas', async () => {
  const customer = await http.loginAs('customer@arvo.test');
  const agent = await http.loginAs('anil@arvo.test');
  assert.equal((await customer.get('/api/agent/tickets')).status, 403);
  assert.equal((await customer.get('/api/customer/tickets')).status, 200);
  assert.equal((await agent.get('/api/customer/tickets')).status, 403);
});

test('signed-in users can change their password', async () => {
  const customer = await http.registerCustomer({
    name: 'Password Change',
    email: 'password.change@example.test',
    password: 'starting-test-password',
  });
  const changed = await customer.post('/api/auth/change-password', {
    currentPassword: 'starting-test-password',
    newPassword: 'replacement-test-password',
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.user.passwordChangeRequired, false);

  const oldLogin = await http.call('POST', '/api/auth/login', {
    body: { email: 'password.change@example.test', password: 'starting-test-password' },
  });
  const newLogin = await http.call('POST', '/api/auth/login', {
    body: { email: 'password.change@example.test', password: 'replacement-test-password' },
  });
  assert.equal(oldLogin.status, 401);
  assert.equal(newLogin.status, 200);
});

test('only a lead can issue temporary customer passwords, which are forced to change', async () => {
  const customer = await http.registerCustomer({
    name: 'Reset Customer',
    email: 'reset.customer@example.test',
    password: 'initial-reset-password',
  });
  const agent = await http.loginAs('anil@arvo.test');
  const lead = await http.loginAs('meera@arvo.test');
  assert.equal((await agent.get('/api/agent/customers')).status, 403);
  assert.equal((await agent.post(`/api/agent/customers/${customer.json.user.id}/password-reset`)).status, 403);

  const listed = await lead.get('/api/agent/customers');
  assert.ok(listed.json.customers.some((account) => account.id === customer.json.user.id));
  const reset = await lead.post(`/api/agent/customers/${customer.json.user.id}/password-reset`);
  assert.equal(reset.status, 200);
  assert.ok(reset.json.temporaryPassword.length >= 30);
  assert.equal((await customer.get('/api/customer/tickets')).json.error.code, 'password_change_required');

  const forcedLogin = await http.call('POST', '/api/auth/login', {
    body: { email: 'reset.customer@example.test', password: reset.json.temporaryPassword },
  });
  assert.equal(forcedLogin.status, 200);
  assert.equal(forcedLogin.json.user.passwordChangeRequired, true);
  const forcedClient = await http.loginAs('reset.customer@example.test', reset.json.temporaryPassword);
  assert.equal((await forcedClient.get('/api/customer/tickets')).status, 403);
  const changed = await forcedClient.post('/api/auth/change-password', {
    currentPassword: reset.json.temporaryPassword,
    newPassword: 'customer-changed-password',
  });
  assert.equal(changed.status, 200);
  assert.equal((await forcedClient.get('/api/customer/tickets')).status, 200);
});

test('only a lead can create agents and new agents must change their temporary password', async () => {
  const agent = await http.loginAs('anil@arvo.test');
  const lead = await http.loginAs('meera@arvo.test');
  const input = {
    name: 'New Agent',
    email: 'new.agent@example.test',
    role: 'lead',
  };
  assert.equal((await agent.post('/api/agent/users', input)).status, 403);

  const created = await lead.post('/api/agent/users', input);
  assert.equal(created.status, 201);
  assert.equal(created.json.agent.role, 'agent');
  assert.equal(created.json.agent.passwordChangeRequired, true);
  assert.ok(created.json.temporaryPassword.length >= 30);
  assert.ok(!created.text.includes('passwordHash') && !created.text.includes('$2'));

  const listed = await lead.get('/api/agent/users');
  assert.ok(listed.json.users.some((user) => user.email === input.email && user.role === 'agent'));

  const duplicate = await lead.post('/api/agent/users', {
    name: 'Duplicate Agent',
    email: input.email.toUpperCase(),
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.code, 'email_in_use');

  const newAgent = await http.loginAs(input.email, created.json.temporaryPassword);
  assert.equal((await newAgent.get('/api/agent/tickets')).json.error.code, 'password_change_required');
  const changed = await newAgent.post('/api/auth/change-password', {
    currentPassword: created.json.temporaryPassword,
    newPassword: 'new-agent-password-2026',
  });
  assert.equal(changed.status, 200);
  assert.equal((await newAgent.get('/api/agent/tickets')).status, 200);
});

test('a tampered or garbage cookie is rejected', async () => {
  const anil = await http.loginAs('anil@arvo.test');
  const tampered = anil.cookie.slice(0, -3) + 'abc';
  assert.equal((await http.call('GET', '/api/auth/me', { cookie: tampered })).status, 401);
  assert.equal((await http.call('GET', '/api/auth/me', { cookie: `${SESSION_COOKIE}=garbage` })).status, 401);
});

test('an expired session is rejected', async () => {
  const [anil] = await world.db.select().from(users).where(eq(users.email, 'anil@arvo.test'));
  const expired = signSession({ uid: anil.id, exp: Math.floor(Date.now() / 1000) - 10 }, 'test-secret');
  assert.equal(verifySession(expired, 'test-secret'), null);
  assert.equal((await http.call('GET', '/api/auth/me', { cookie: `${SESSION_COOKIE}=${expired}` })).status, 401);
});

test('a session signed with another secret is rejected', async () => {
  const [anil] = await world.db.select().from(users).where(eq(users.email, 'anil@arvo.test'));
  const forged = signSession({ uid: anil.id, exp: Math.floor(Date.now() / 1000) + 600 }, 'attacker-secret');
  assert.equal((await http.call('GET', '/api/auth/me', { cookie: `${SESSION_COOKIE}=${forged}` })).status, 401);
});

test('deactivating a user ends their existing session immediately', async () => {
  const joseph = await http.loginAs('joseph@arvo.test');
  assert.equal((await joseph.get('/api/auth/me')).status, 200);
  await world.db.update(users).set({ active: false }).where(eq(users.email, 'joseph@arvo.test'));
  assert.equal((await joseph.get('/api/auth/me')).status, 401);
  const relogin = await http.call('POST', '/api/auth/login', { body: { email: 'joseph@arvo.test', password: PASSWORD } });
  assert.equal(relogin.status, 401);
});

test('logout clears the cookie', async () => {
  const res = await http.call('POST', '/api/auth/logout', { body: {} });
  assert.equal(res.status, 204);
  assert.match(res.headers.getSetCookie()[0], /Max-Age=0/);
});

test('a POST from another origin is blocked (CSRF guard)', async () => {
  const anil = await http.loginAs('anil@arvo.test');
  const res = await http.call('POST', '/api/auth/logout', { cookie: anil.cookie, body: {}, headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'cross_origin_blocked');
  // The same site is fine.
  const ok = await http.call('POST', '/api/auth/logout', {
    cookie: anil.cookie, body: {}, headers: { Origin: http.base },
  });
  assert.equal(ok.status, 204);
});

test('malformed JSON gets a clean 400, not a stack trace', async () => {
  const res = await fetch(`${http.base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops',
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error.code, 'invalid_json');
});
