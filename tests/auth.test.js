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
  assert.deepEqual(Object.keys(res.json.user).sort(), ['email', 'id', 'name', 'role']);
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
