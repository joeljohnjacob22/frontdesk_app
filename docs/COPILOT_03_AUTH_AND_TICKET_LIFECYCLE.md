# COPILOT 03: Authentication and the Ticket Lifecycle API

**Project:** Frontdesk (Arvo Systems hiring test). **Previous steps:** 01 setup and migrations, 02 business-time and SLA engine (both done, `npm test` green with 40 tests).

| # | Document | Delivers |
|---|---|---|
| 01 | Setup and migrations | Repo, DB, seed, skeleton, test harness (**done**) |
| 02 | Business-time and SLA engine | Pure time module, due-date maths (**done**) |
| **03** | **Auth and ticket lifecycle API (this file)** | Login, claim, reply, note, priority, resolve, reopen, linked tickets, audit events, customer view, privacy tests |
| 04 | Background job and exports | Breach detection while tickets sit, auto-close, resolved→closed, CSV/JSON export |
| 05 | Agent UI and customer view | React screens |
| 06 | Deploy and README | Hosting, README, "what I did not finish" note |

---

## 0. What this step is, and how to run it

This is the step where the three incident reports (§4 of the hiring test) become code and tests:

| Incident | What must be true | Proved by |
|---|---|---|
| **INC-0291** two agents took the same ticket | Exactly one claim wins. Only the owner can reply. Enforced on the **server**. | `lifecycle.test.js`, `agentApi.test.js` (claim races) |
| **INC-0304** a private note reached a customer | A note is never in any customer response, any list, or any audit payload. Also enforced by the database role. | `privacy.test.js` (including a run through a DB role that can read only two views) |
| **INC-0318** nobody could prove who replied when | Every action is an immutable, hash-chained event with a server-set time. Replies and breaches are recorded at write time. | `lifecycle.test.js` (audit test) |

**Working method (same as steps 01 and 02):** paste the prompt from Step 01 §0, with this file's name and the step number. Do the steps in order. **All test files in §6 Step 1 are LOCKED.** Copilot writes the implementation to satisfy them and must never edit a test to make it pass. An appendix has a reference implementation to compare against only if Copilot is stuck.

> **Files this step REPLACES from step 01:** `server/app.js` and `server/index.js`. Step 01's `tests/health.test.js` must keep passing unchanged.
> **One correction to step 01:** `db/client.js` no longer runs `SET TIME ZONE` on connect. It was unnecessary (all time columns are `timestamptz`, the audit hash uses epoch seconds) and triggered a `pg` deprecation warning. If your copy still has the `pool.on('connect', ...)` line, delete it.
> **No new npm dependencies.** Sessions use `node:crypto`, and cookies are parsed by hand (about 15 lines).

---

## 1. Decisions to append to `docs/DECISIONS.md`

Copilot adds these rows when this step is committed. They become the decision log in the README.

| # | Decision | Reason |
|---|---|---|
| 1 | The **customer chooses severity** on the new-ticket form (high = "cannot work at all", medium, low = "a question"). Default medium. Agents can change it. | Meera's tiers are defined by customer impact. Nobody else knows it at the start. |
| 2 | **Only the owner can send a public reply or resolve.** Any signed-in staff member can add a team note. | INC-0291 (two conflicting answers). Notes are internal, so any teammate may help. |
| 3 | A lead can **release, reassign, or change the priority** of any ticket. The owner can release and change priority on their own. | Leads need a way out when an owner is away. |
| 4 | Only a **public reply** counts as the first response. A note never stops the reply clock. | A note is invisible to the customer. |
| 5 | A ticket becomes `waiting_on_customer` **only through a public reply** with `setWaiting: true`. That opens an SLA pause. | The pause rule is "we asked the customer a question". |
| 6 | **Resolving while waiting** closes the pause, and the waiting time is not held against Arvo (the deadline is judged at the moment the wait began). | Meera: "that week is not our fault". |
| 7 | **A customer message on a resolved ticket inside the reopen window reopens it** (new SLA cycle, same owner). Reopen needs a message. | One endpoint, and Arvo learns what is still wrong. |
| 8 | A customer message on a **closed** ticket, or a resolved ticket **past the window**, creates a **new ticket** with `parent_ticket_id` set and its own link. Auto-closed tickets are handled the same way. | Meera: "after that it is a new ticket", "they can always contact us again". |
| 9 | **The database clock is the time authority.** All timestamps come from `clock_timestamp()` in the same transaction. Tests inject a fake clock. | INC-0318: one source of truth for "when". |
| 10 | **Breaches are also recorded at write time** (late first reply, late resolve), not only by the background job. | The job runs once a minute. A late reply must never go unrecorded if it has not run. |
| 11 | The agent **list never selects message text**. | INC-0304: "Not in a list". No previews, no snippets. |
| 12 | Customer reads go through **`customer_*` views only**, optionally on a **view-only DB role** (`CUSTOMER_DATABASE_URL`). | Defence in depth for INC-0304. |
| 13 | Sessions are a **signed, HttpOnly, SameSite=Lax cookie** (12 hours), re-checked against the database on every request. Cross-site writes are blocked by an `Origin` check. | No dependency. Deactivating a user takes effect immediately. |
| 14 | `404 ticket_not_found` for **both** unknown and malformed tokens. Login says "Wrong email or password" for both unknown email and wrong password. | Do not reveal what exists. |
| 15 | **Not built (list in the closing note):** login rate limiting, email verification or delivery, token rotation, pagination of the list, idle-lease auto-release, live presence. | Out of an 8-hour scope. |

---

## 2. Who may do what

| Operation | Anonymous (token holder) | Agent | Lead | Owner of the ticket |
|---|---|---|---|---|
| Raise a ticket, view and reply by link | ✅ (their own ticket only) | | | |
| List and view tickets (all, including notes) | | ✅ | ✅ | ✅ |
| Add a team note | | ✅ | ✅ | ✅ |
| Claim an unclaimed ticket | | ✅ | ✅ | |
| **Public reply** | | ❌ | ❌ | ✅ |
| **Resolve** | | ❌ | ❌ | ✅ |
| Change priority | | ❌ | ✅ | ✅ |
| Release | | ❌ | ✅ | ✅ |
| Reassign, list users | | ❌ | ✅ | |

## 3. Operation contracts (the spec for `server/services/tickets.js`)

Every operation runs in **one transaction**, locks the ticket row with `SELECT ... FOR UPDATE` (except `createTicket`), takes `now` once from the clock, and writes its audit events **inside the same transaction**.

| Operation | Allowed when | What it does | Events written | Errors |
|---|---|---|---|---|
| `createTicket` | always | Upsert customer by `lower(email)`. Insert ticket (`new`, token hash), first public message, SLA cycle 1 | `ticket_created`, `sla_cycle_started` | none (input is validated in the route) |
| `claimTicket` | unassigned, status new / open / waiting | Set assignee and `claimed_at`. `new` becomes `open`. The `UPDATE` itself is guarded by `assignee_id IS NULL` as a second line of defence | `claimed {status_after}` | 404 `ticket_not_found`, 409 `already_claimed`, 409 `not_claimable` |
| `releaseTicket` | assigned | Clear assignee. Status unchanged | `released {from_user_id, by_lead}` | 409 `not_assigned`, 403 `forbidden` |
| `reassignTicket` | lead; status new / open / waiting; target active | Set assignee to target. `new` becomes `open` | `reassigned {from_user_id, to_user_id}` | 403 `forbidden`, 409 `not_claimable`, 400 `validation_error` |
| `addNote` | any status | Insert a `note` message. **No SLA change.** | `note_added {body_sha256}` | 404 |
| `replyPublic` | caller is owner; status open or waiting | Insert public message. If first reply: set `first_response_at` and check the reply breach. If `setWaiting` and status is `open`: status becomes `waiting_on_customer`, `auto_close_at = autoCloseAt(now)`, open an `sla_pauses` row | `public_reply_sent {body_sha256, first_response}`, maybe `reply_breached`, `status_changed`, `sla_paused` | 409 `claim_required` (unclaimed), 403 `not_owner`, 409 `ticket_closed` |
| `setPriority` | owner or lead; status new / open / waiting | Same priority: return unchanged, no event. Otherwise `recomputeForPriority` with the **sum of finished pauses**, update cycle and ticket. Recorded breaches are never cleared | `priority_changed {from, to, old/new reply and resolve due}` | 403 `forbidden`, 409 `ticket_closed` |
| `resolveTicket` | caller is owner; status open or waiting | Close an open pause (`sla_resumed`). Breach checks: reply (if never answered) and resolve, **judged at the pause start if waiting**. End the cycle. Status `resolved`, `reopen_until = reopenUntil(now)` | `sla_resumed`?, `reply_breached`?, `resolve_breached`?, `resolved`, `status_changed` | 403 `not_owner`, 409 `ticket_closed` |
| `customerMessage` | any (token) | See the outcome table below | see below | 404 `ticket_not_found` |

**`customerMessage` outcomes**

| Ticket state when the customer writes | Outcome | What happens | Events |
|---|---|---|---|
| new or open | `replied` | Insert message (`recipient_user_id` = owner). No SLA change | `customer_replied` |
| waiting_on_customer | `replied` | Insert message. Close the pause (`business_minutes`). `resolve_due_at = dueDates(... + total finished pause minutes)`. Reply deadline untouched. Status `open` | `customer_replied {resumed_sla}`, `sla_resumed {business_minutes}`, `status_changed` |
| resolved and `now <= reopen_until` | `reopened` | Insert message. Status `open`, `reopen_count + 1`, owner kept. **New SLA cycle** (`cycle_no + 1`, `is_reopen`) | `customer_replied`, `reopened`, `status_changed`, `sla_cycle_started` |
| resolved and `now > reopen_until`, or closed | `new_ticket` | New ticket: same customer, subject `Re: <old subject>` (once), same priority, `parent_ticket_id`, **its own token** | on the old ticket `linked_ticket_created {child_ticket_id}`. On the new one `ticket_created`, `sla_cycle_started`, `linked_ticket_created {parent_ticket_id}` |

Two simultaneous customer replies on a waiting ticket must resume the clock **once**. The row lock makes the second one a plain reply.

## 4. API reference

All bodies are JSON. All errors are `{ "error": { "code", "message" } }`. All times are ISO-8601 UTC (`...Z`).

**Auth**

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `POST /api/auth/login` | `{ email, password }` | 200 `{ user: { id, name, email, role } }` + session cookie | 400 `validation_error`, 401 `invalid_credentials` |
| `POST /api/auth/logout` | none | 204, cookie cleared | |
| `GET /api/auth/me` | | 200 `{ user }` | 401 `unauthenticated` |

**Agent** (all need a session, else 401 `unauthenticated`)

| Method and path | Body | Success |
|---|---|---|
| `GET /api/agent/tickets?view=` | `view`: `open` (default), `mine`, `unclaimed`, `waiting`, `late`, `resolved`, `all` | 200 `{ tickets: [ { id, ticketNo, subject, priority, status, customerName, assignee, isMine, isUnclaimed, isWaiting, isLate, replyLate, resolveLate, nextDueAt, replyDueAt, resolveDueAt, waitingSince, autoCloseAt, reopenUntil, createdAt, updatedAt } ] }`, late first, then by next deadline. **No message text.** |
| `GET /api/agent/tickets/:id` | | 200 `{ ticket, messages (notes included, with kind), events, sla: { cycles, pauses } }` |
| `POST /api/agent/tickets/:id/claim` | | 200 `{ ticket }` |
| `POST /api/agent/tickets/:id/release` | | 200 `{ ticket }` |
| `POST /api/agent/tickets/:id/reassign` | `{ userId }` (lead) | 200 `{ ticket }` |
| `POST /api/agent/tickets/:id/replies` | `{ body, setWaiting? }` | 201 `{ messageId, ticket }` |
| `POST /api/agent/tickets/:id/notes` | `{ body }` | 201 `{ messageId }` |
| `PATCH /api/agent/tickets/:id/priority` | `{ priority }` | 200 `{ ticket }` |
| `POST /api/agent/tickets/:id/resolve` | | 200 `{ ticket }` |
| `GET /api/agent/users` | (lead) | 200 `{ users: [ { id, name, role, active } ] }` |

**Customer** (no login, the token in the URL is the credential)

| Method and path | Body | Success |
|---|---|---|
| `POST /api/customer/tickets` | `{ name, email, subject, body, priority? }` | 201 `{ token, link, ticket: { ticketNo } }` (the **only** time the raw token is shown) |
| `GET /api/customer/tickets/:token` | | 200 `{ ticketNo, subject, status, createdAt, resolvedAt, reopenUntil, closedAt, canReopen, messages: [ { id, authorType, authorName, body, createdAt } ] }` |
| `POST /api/customer/tickets/:token/messages` | `{ body }` | 201 `{ outcome, ticketNo }` plus `{ token, link }` when `outcome` is `new_ticket` |

**Error codes:** 400 `validation_error`, `invalid_json` · 401 `unauthenticated`, `invalid_credentials` · 403 `forbidden`, `not_owner`, `cross_origin_blocked` · 404 `ticket_not_found`, `not_found` · 409 `already_claimed`, `claim_required`, `not_claimable`, `not_assigned`, `ticket_closed` · 500 `internal_error` (never contains SQL or a stack trace).

Validation limits: `name` 100, `email` 254 and a valid shape, `subject` 200, message `body` 10,000 (whitespace-only is empty), `priority` one of `high` / `medium` / `low`. `:id` must be a positive integer, otherwise 404.

---

## 5. Files

```
server/
  lib/        errors.js  format.js  tokens.js  validate.js  session.js      (new, small, pure)
  services/   events.js  tickets.js  queries.js                              (new)
  middleware/ auth.js                                                        (new)
  routes/     auth.js  agent.js  customer.js                                 (new)
  app.js  index.js                                                           (REPLACED)
tests/
  helpers/world.js                                                           (new)
  auth.test.js  lifecycle.test.js  agentApi.test.js  customerApi.test.js  privacy.test.js
docs/smoke.sh                                                                (new)
```

---

## 6. Steps

### Step 1: Test helper and the five test files (write them FIRST, expect red)

`tests/helpers/world.js` gives every test a throwaway database, the seeded staff, the engine, a **fake clock** and ready-made services, so a test can say "it is Friday 17:20" in one line. `startServer` runs the real Express app on a random port and returns an HTTP client that keeps the session cookie.

```js file=tests/helpers/world.js
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { asc, eq, isNull, and } from 'drizzle-orm';
import { slaCycles, slaPauses, ticketEvents, tickets, users } from '../../db/schema.js';
import { seedUsers } from '../../db/seed.js';
import { createApp } from '../../server/app.js';
import { loadEngineConfig } from '../../server/lib/engineConfig.js';
import { createTicketService } from '../../server/services/tickets.js';
import { createTestDb } from './testDb.js';
import { ist } from './time.js';

export const PASSWORD = 'pw-for-tests';
export const sha = (x) => crypto.createHash('sha256').update(x).digest();

// A clock you control. Pass it to the services so "Friday 17:20" and "Wednesday 10:00" are one line each.
export function makeClock(start) {
  let ms = ist(start).getTime();
  const clock = async () => new Date(ms);
  clock.set = (text) => { ms = ist(text).getTime(); };
  clock.setMs = (value) => { ms = value; };
  return clock;
}

// Everything a lifecycle test needs: throwaway DB, seeded staff, engine, fake clock, services.
export async function createWorld({ start = '2026-11-20 17:00' } = {}) {
  const ctx = await createTestDb();
  await seedUsers(ctx.db, PASSWORD);
  const engine = await loadEngineConfig(ctx.db);
  const clock = makeClock(start);
  const svc = createTicketService({ db: ctx.db, getEngine: async () => engine, clock });
  const all = await ctx.db.select().from(users);
  const staff = Object.fromEntries(all.map((u) => [u.email.split('@')[0], u]));   // staff.meera, staff.anil, ...

  return {
    ...ctx, engine, clock, svc, staff,
    lead: staff.meera, agent: staff.anil, agent2: staff.priya,
    agents: all.filter((u) => u.role === 'agent'),

    async newTicket(overrides = {}) {
      const out = await svc.createTicket({
        name: 'Test Customer', email: 'customer@example.com', subject: 'Cannot log in',
        body: 'Please help', priority: 'medium', ...overrides,
      });
      return out;                                                    // { ticket, token }
    },
    async claimed(overrides = {}, owner = staff.anil) {
      const out = await this.newTicket(overrides);
      await svc.claimTicket(out.ticket.id, owner);
      return out;
    },
    async ticket(id) { return (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]; },
    async cycles(ticketId) {
      return ctx.db.select().from(slaCycles).where(eq(slaCycles.ticketId, ticketId)).orderBy(asc(slaCycles.cycleNo));
    },
    async cycle(ticketId) {
      return (await ctx.db.select().from(slaCycles)
        .where(and(eq(slaCycles.ticketId, ticketId), isNull(slaCycles.endedAt))))[0];
    },
    async pauses(ticketId) {
      return ctx.db.select().from(slaPauses).where(eq(slaPauses.ticketId, ticketId)).orderBy(asc(slaPauses.id));
    },
    async events(ticketId) {
      return ctx.db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticketId)).orderBy(asc(ticketEvents.chainSeq));
    },
    async eventTypes(ticketId) { return (await this.events(ticketId)).map((e) => e.type); },
  };
}

// Error assertion for services: status + machine-readable code.
export function rejectsWith(promise, status, code) {
  return assert.rejects(promise, (err) => {
    assert.equal(err.status, status, `expected HTTP ${status}, got ${err.status} (${err.message})`);
    assert.equal(err.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------- HTTP
export async function startServer(world, { customerDb } = {}) {
  const app = createApp({
    db: world.db,
    customerDb: customerDb ?? world.db,
    getEngine: async () => world.engine,
    clock: world.clock,
    sessionSecret: 'test-secret',
    clientDir: '/nonexistent',
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { body, cookie, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  // Signs in and returns a small client that sends the session cookie.
  async function loginAs(email, password = PASSWORD) {
    const res = await call('POST', '/api/auth/login', { body: { email, password } });
    assert.equal(res.status, 200, `login failed: ${res.text}`);
    const cookie = res.headers.getSetCookie()[0].split(';')[0];
    return {
      cookie,
      get: (p) => call('GET', p, { cookie }),
      post: (p, body = {}) => call('POST', p, { body, cookie }),
      patch: (p, body) => call('PATCH', p, { body, cookie }),
    };
  }

  const anon = {
    get: (p) => call('GET', p),
    post: (p, body = {}) => call('POST', p, { body }),
  };

  return { base, call, loginAs, anon, close: () => new Promise((resolve) => server.close(resolve)) };
}
```

**Authentication tests**

```js file=tests/auth.test.js
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
```

**Lifecycle tests** (claim race, waiting and resume, priority, resolve, reopen, linked tickets, audit trail). IST times from the step 02 cheat sheet: Fri 20 Nov 2026, Mon 23, Wed 25, Fri 27, Mon 30.

```js file=tests/lifecycle.test.js
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
```

**Agent API tests**

```js file=tests/agentApi.test.js
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
```

**Customer API tests**

```js file=tests/customerApi.test.js
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
```

**Privacy tests (INC-0304).** The last two tests run every customer read through a database role that can read **only** the two customer views. If any customer code path touched a table, it would fail with `permission denied`. They are skipped only if the `frontdesk_customer_reader` role does not exist (a host that refused `0002`).

```js file=tests/privacy.test.js
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
```

**Verify (expected RED):** `npm test` fails: `Cannot find module '../server/lib/...'`. Correct. Do not stub modules to silence it.

---

### Step 2: Small library modules (`server/lib/`)

Create `errors.js`, `format.js`, `tokens.js`, `validate.js`, `session.js`. Specs:

| File | Exports | Rules |
|---|---|---|
| `errors.js` | `HttpError(status, code, message)` | Thrown from services and routes. The error handler in `app.js` turns it into the JSON error shape |
| `format.js` | `formatTicketNo(n)` → `FD-0042`, `iso(date)` | `iso(null)` is `null` |
| `tokens.js` | `newToken()`, `hashToken(token)`, `bodyHash(body)` | Token = 24 random bytes, base64url. `hashToken` = SHA-256 **Buffer**. `bodyHash` = SHA-256 hex |
| `validate.js` | `requireString`, `requireEmail`, `requireOneOf`, `optionalBoolean`, `parseId` | All failures are `HttpError(400, 'validation_error', ...)`. Strings are trimmed. `parseId` failures are 404 |
| `session.js` | `signSession`, `verifySession`, `parseCookies`, `sessionCookie`, constants | HMAC-SHA256, constant-time compare (`crypto.timingSafeEqual`), expiry in epoch **seconds**, cookie `HttpOnly; SameSite=Lax; Path=/` (+`Secure` in production). **No `jsonwebtoken` or `cookie-parser`** |

**Verify:** `node --test tests/auth.test.js` still fails (no app yet). That is fine. Check the modules import: `node -e "import('./server/lib/session.js')"`.

### Step 3: Audit helper and the ticket service

1. `server/services/events.js`: `logEvent(tx, { ticketId, type, actor, messageId, payload })` plus `staffActor(user)`, `customerActor(customerId)`, `SYSTEM`. The insert passes a placeholder `hash: Buffer.alloc(0)`; the database trigger overwrites it. **Never put message text in a payload.**
2. `server/services/tickets.js`: `createTicketService({ db, getEngine, clock })` returning every operation in §3. Rules for the whole file:
   - One `inTx` helper: loads the engine, opens a transaction, takes `now` **once** from `clock(tx)`. The default clock reads `clock_timestamp()` from the database. Use that `now` for every timestamp the operation writes, including `messages.created_at`.
   - Lock first (`.for('update')`), then check permissions, then check status, then write. Throw `HttpError` with the exact codes in §3.
   - Use the engine functions from step 02 (`startCycle`, `dueDates`, `recomputeForPriority`, `pausedMinutes`, `autoCloseAt`, `reopenUntil`, `isOverdue`). **No date arithmetic in this file.**
   - Breach flags are written **once** (`... WHERE reply_breached_at IS NULL`) and always together with their event.

**Verify:** `node --test tests/lifecycle.test.js` shows 27 pass. (It needs only the service, not the HTTP layer.)

### Step 4: Read-side queries

`server/services/queries.js`: `createQueries({ db, customerDb, clock })` returning `listTickets(user, view)`, `getAgentTicket(id)`, `listUsers()`, `getCustomerTicket(token)`.

- `listTickets` reads the `agent_ticket_list` **view** joined to `customers` and `users`. It selects **no message column**. Order: late first, then `next_due_at ASC NULLS LAST`, then id. `isLate = replyLate || resolveLate`. The `late` view only includes active tickets (new, open, waiting).
- `getAgentTicket` returns the full thread **including notes with `kind`**, the audit events (by `chain_seq`), cycles and pauses. It must **never** return `access_token_hash`.
- `getCustomerTicket` uses **only** `customerDb` and **only** the `customer_tickets` and `customer_messages` views, filtered by `access_token_hash = hashToken(token)`. Build the response from a hand-written field list. `canReopen = status === 'resolved' && reopenUntil >= now`.

### Step 5: Middleware, routes, app and boot

1. `server/middleware/auth.js`: `loadSession` (cookie → verified → user **re-read from the DB, active only** → `req.user`), `requireAgent`, `requireLead`, `sameOrigin` (a write with a foreign `Origin` header is 403 `cross_origin_blocked`).
2. `server/routes/auth.js`: login compares with bcrypt **even when the email is unknown** (against a dummy hash) and returns the same 401 for both cases. The login response never includes the hash.
3. `server/routes/agent.js` and `server/routes/customer.js`: thin. Validate input, call the service, shape the response by hand. All business rules stay in the service.
4. **Replace** `server/app.js`: the factory takes `{ db, customerDb, getEngine, clock, sessionSecret, secureCookies, clientDir }`, mounts `/api/auth`, `/api/agent`, `/api/customer`, keeps `/api/health`, the JSON 404 for unknown `/api/*`, the static client, and an error handler that maps `err.type === 'entity.parse.failed'` to 400 `invalid_json`.
5. **Replace** `server/index.js`: build `customerDb` from `CUSTOMER_DATABASE_URL` when set, pass `config.sessionSecret` and `secureCookies: config.isProd`.

**Verify:** `node --test tests/auth.test.js tests/agentApi.test.js tests/customerApi.test.js tests/privacy.test.js` all pass.

### Step 6: Full run, timezone check, smoke test, commit

```bash
npm test                                   # 109 tests, 0 failing
TZ=America/Los_Angeles npm test            # same
npm run db:reset && npm run db:seed        # clean database
npm run dev:server &                       # then, in another terminal:
bash docs/smoke.sh                         # ends with: ALL SMOKE CHECKS PASSED
```

`docs/smoke.sh` walks one ticket through the whole lifecycle against the **running** server and checks the private-note rule from the outside:

```bash file=docs/smoke.sh
#!/usr/bin/env bash
# End-to-end smoke test against a RUNNING server:  BASE=http://localhost:3000 bash docs/smoke.sh
# It walks one ticket through the whole lifecycle and checks the private-note rule from the outside.
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
PASSWORD="${SEED_PASSWORD:-frontdesk-demo}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
SECRET="SECRET-NOTE-$RANDOM$RANDOM"

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=eval("j."+process.argv[1]);console.log(v)})' "$1"; }
post() { curl -s -b "$JAR" -X POST "$BASE$1" -H 'Content-Type: application/json' -d "$2"; }

echo "1. customer raises a ticket"
CREATED=$(curl -s -X POST "$BASE/api/customer/tickets" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Test","email":"smoke@example.com","subject":"Smoke test","body":"Hello from curl","priority":"high"}')
TOKEN=$(echo "$CREATED" | jget token)
echo "   ticket $(echo "$CREATED" | jget ticket.ticketNo), link /t/${TOKEN:0:8}..."

echo "2. an agent signs in and finds it"
curl -s -c "$JAR" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"anil@arvo.test\",\"password\":\"$PASSWORD\"}" >/dev/null
ID=$(curl -s -b "$JAR" "$BASE/api/agent/tickets?view=unclaimed" | jget 'tickets.find(t => t.subject === "Smoke test").id')
echo "   internal id $ID"

echo "3. claim it (a second claim must be refused)"
post "/api/agent/tickets/$ID/claim" '{}' | jget ticket.status
CODE=$(post "/api/agent/tickets/$ID/claim" '{}' | jget error.code)
[ "$CODE" = "already_claimed" ] && echo "   second claim refused: $CODE"

echo "4. private team note, then a public reply that waits on the customer"
post "/api/agent/tickets/$ID/notes" "{\"body\":\"$SECRET\"}" >/dev/null
post "/api/agent/tickets/$ID/replies" '{"body":"Can you tell us your username?","setWaiting":true}' | jget ticket.status

echo "5. what the CUSTOMER sees"
VIEW=$(curl -s "$BASE/api/customer/tickets/$TOKEN")
echo "   status: $(echo "$VIEW" | jget status), messages: $(echo "$VIEW" | jget messages.length)"
if echo "$VIEW" | grep -q "$SECRET"; then echo "FAIL: the private note reached the customer"; exit 1; fi
echo "   PASS: the private note is not in the customer view"

echo "6. what the agent LIST shows (must contain no message text)"
LIST=$(curl -s -b "$JAR" "$BASE/api/agent/tickets?view=all")
if echo "$LIST" | grep -q -e "$SECRET" -e "Hello from curl"; then echo "FAIL: message text in the list"; exit 1; fi
echo "   PASS: no message text in the list"

echo "7. customer answers, then the agent resolves"
post_c() { curl -s -X POST "$BASE/api/customer/tickets/$TOKEN/messages" -H 'Content-Type: application/json' -d "$1"; }
echo "   outcome: $(post_c '{"body":"It is smoke.user"}' | jget outcome)"
post "/api/agent/tickets/$ID/resolve" '{}' | jget ticket.status
echo "   customer can now reopen: $(curl -s "$BASE/api/customer/tickets/$TOKEN" | jget canReopen)"
echo "ALL SMOKE CHECKS PASSED"
```

Append the §1 rows to `docs/DECISIONS.md`, then:

```bash
git add -A && git commit -m "step 3: auth and ticket lifecycle API with tests"
```

---

## 7. Acceptance checklist

| # | Check | Expected |
|---|---|---|
| 1 | `npm test` | **109 pass**, 0 fail (40 from steps 01 and 02, plus 13 + 27 + 11 + 10 + 8 = 69 new) |
| 2 | `TZ=America/Los_Angeles npm test` | Same |
| 3 | `npm test` prints no `DeprecationWarning` | none |
| 4 | `bash docs/smoke.sh` against a running server | `ALL SMOKE CHECKS PASSED` |
| 5 | Tests unmodified | `git diff tests/` is empty after Step 1's commit |
| 6 | `grep -rn "body" server/services/events.js` | Only the comment. Events never receive a body |
| 7 | `grep -rn "from(messages)" server/services/queries.js` | Exactly one match, inside `getAgentTicket`. The list and customer paths never read `messages` |
| 8 | `grep -rn "customerMessages\|customerTickets" server/services/queries.js` | Used by `getCustomerTicket` |
| 9 | `grep -rn "new Date()\|Date.now()" server/services server/routes` | No matches (the clock is injected; the session expiry in `routes/auth.js` is the one allowed exception) |
| 10 | `npm ls --depth=0` | No new dependency since step 01 |
| 11 | `docs/DECISIONS.md` | Contains the 15 rows from §1 |

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Claim race test shows two winners | Check-then-update without a lock | `lockTicket` (`.for('update')`) first, and keep `isNull(assigneeId)` in the `UPDATE ... WHERE` |
| A later reply moves `first_response_at` | Updated the cycle on every reply | Only when `cycle.firstResponseAt` is null |
| Resume test: deadline is wrong | Forgot the earlier pauses | Resolve due = `dueDates(..., pausedBusinessMinutes: SUM of ALL finished pauses)`, and reply due is not touched |
| Reopen at exactly the deadline creates a new ticket | Used `<=` | New ticket only when `reopenUntil < now` |
| `tx.update(...).returning()` returns the OLD status for events | Reading before the update | Use the returned row for "after", the locked row for "before" |
| `Failed query: ...` and no detail | Drizzle wraps driver errors | Read `err.cause` |
| Customer view returns 500 in the restricted-role test | Customer code touched a table | Only the two `customer_*` views. The view columns are all it can read |
| Login works but `/me` is 401 | Cookie not sent, or `Secure` over http | `secureCookies` only in production. Use the `loginAs` helper in tests |
| A 403 `cross_origin_blocked` in the browser dev setup | Vite proxy rewrote the `Host` header | Do not set `changeOrigin: true` in `client/vite.config.js` |
| `Cannot read properties of undefined (reading 'body')` | Express 5 leaves `req.body` undefined when no body is sent | Use `req.body?.field` (the reference does) |
| Late-flag test is flaky | Uses `agent_ticket_list`, which compares with the real `now()` | The tests create tickets 30 days in the past or future relative to the real clock. Do not hard-code dates there |
| Copilot edits a test to make it pass | Violates the LOCKED rule | `git checkout tests/` and re-run |

## 9. Out of scope for this step

The background job that catches breaches while a ticket is sitting and auto-closes waiting or resolved tickets (**step 04**, which also adds the CSV/JSON export), the React screens (**step 05**), deployment and the README (**step 06**). `customer_replied` on a ticket that the job has not yet closed works already, because the reopen-window check uses `reopen_until`, not the status alone.

---

## Appendix: reference implementation (use ONLY if Copilot is stuck)

This passes all 109 tests, and `docs/smoke.sh`. Try §6 first. If a test still fails after two attempts, compare against this and ask Copilot to explain the difference.

```js ref=server/lib/errors.js
// Throw this from services and routes. The error handler in app.js turns it into
// { "error": { "code": "...", "message": "..." } } with the given status.
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
```

```js ref=server/lib/format.js
export const formatTicketNo = (n) => `FD-${String(n).padStart(4, '0')}`;

// Dates leave the API as ISO-8601 UTC ("...Z"). null stays null.
export const iso = (value) => (value == null ? null : new Date(value).toISOString());
```

```js ref=server/lib/tokens.js
import crypto from 'node:crypto';

// The customer's secret link token. 24 random bytes = 192 bits: unguessable.
export const newToken = () => crypto.randomBytes(24).toString('base64url');

// Only this hash is stored (tickets.access_token_hash). A leaked database cannot rebuild a working link.
// Plain SHA-256 is correct here (unlike for passwords) because the token is long and random.
export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest();

// Audit events store this instead of the message text.
export const bodyHash = (body) => crypto.createHash('sha256').update(body).digest('hex');
```

```js ref=server/lib/validate.js
import { HttpError } from './errors.js';

const fail = (message) => new HttpError(400, 'validation_error', message);

export function requireString(value, field, { min = 1, max = 10_000 } = {}) {
  if (typeof value !== 'string') throw fail(`${field} is required`);
  const text = value.trim();
  if (text.length < min) throw fail(`${field} is required`);
  if (text.length > max) throw fail(`${field} must be at most ${max} characters`);
  return text;
}

export function requireEmail(value, field = 'email') {
  const text = requireString(value, field, { max: 254 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw fail(`${field} is not a valid email address`);
  return text;
}

export function requireOneOf(value, field, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw fail(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

export function optionalBoolean(value, field, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw fail(`${field} must be true or false`);
  return value;
}

// Route ids: anything that is not a positive integer is simply "not found".
export function parseId(value) {
  if (!/^[1-9]\d{0,15}$/.test(String(value))) throw new HttpError(404, 'not_found', 'Not found');
  return Number(value);
}
```

```js ref=server/lib/session.js
import crypto from 'node:crypto';

// Stateless signed session cookie: base64url(JSON payload) + "." + HMAC-SHA256 signature.
// No dependency needed. Payload: { uid, exp } with exp in epoch SECONDS.
export const SESSION_COOKIE = 'fd_session';
export const SESSION_MAX_AGE_S = 12 * 60 * 60;

const mac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

// Returns the payload, or null for anything wrong (bad format, bad signature, expired).
export function verifySession(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const given = Buffer.from(parts[1]);
  const expected = Buffer.from(mac(parts[0], secret));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { return null; }
  if (!payload || typeof payload.uid !== 'number' || typeof payload.exp !== 'number') return null;
  if (payload.exp * 1000 <= nowMs) return null;
  return payload;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(value, { maxAge = SESSION_MAX_AGE_S, secure = false } = {}) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
```

```js ref=server/services/events.js
import { ticketEvents } from '../../db/schema.js';

// Who did it. Exactly one shape per actor type (the database enforces the same rule).
export const staffActor = (user) => ({ type: 'staff', userId: user.id });
export const customerActor = (customerId) => ({ type: 'customer', customerId });
export const SYSTEM = Object.freeze({ type: 'system' });

// Append one row to the audit log. Call it INSIDE the transaction of the change it records.
// The database trigger assigns chain_seq, created_at, prev_hash and hash. The placeholder
// hash below only satisfies the NOT NULL column and is always overwritten.
// NEVER put a message body in the payload: use messageId and body_sha256 instead.
export async function logEvent(tx, { ticketId, type, actor, messageId = null, payload = {} }) {
  await tx.insert(ticketEvents).values({
    ticketId,
    type,
    actorType: actor.type,
    actorUserId: actor.userId ?? null,
    actorCustomerId: actor.customerId ?? null,
    messageId,
    payload,
    hash: Buffer.alloc(0),
  });
}
```

```js ref=server/services/tickets.js
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { customers, messages, slaCycles, slaPauses, tickets, users } from '../../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { iso } from '../lib/format.js';
import { bodyHash, hashToken, newToken } from '../lib/tokens.js';
import {
  autoCloseAt, dueDates, isOverdue, pausedMinutes, recomputeForPriority, reopenUntil, startCycle,
} from '../lib/sla.js';
import { SYSTEM, customerActor, logEvent, staffActor } from './events.js';

// Default time source: the DATABASE clock, so every timestamp has one authority (INC-0318).
// Tests inject a fake clock instead.
export const dbClock = async (tx) => {
  const result = await tx.execute(sql`select clock_timestamp() as t`);
  return new Date(result.rows[0].t);
};

const ACTIVE = ['new', 'open', 'waiting_on_customer'];

export function createTicketService({ db, getEngine, clock = dbClock }) {
  // One transaction + one engine snapshot + one "now" per operation.
  async function inTx(fn) {
    const engine = await getEngine();
    return db.transaction(async (tx) => fn(tx, engine, await clock(tx)));
  }

  async function lockTicket(tx, id) {
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, id)).for('update');
    if (!ticket) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
    return ticket;
  }

  async function activeCycle(tx, ticketId) {
    const [cycle] = await tx.select().from(slaCycles)
      .where(and(eq(slaCycles.ticketId, ticketId), isNull(slaCycles.endedAt))).limit(1);
    if (!cycle) throw new Error(`Ticket ${ticketId} has no active SLA cycle`);
    return cycle;
  }

  async function openPause(tx, cycleId) {
    const [pause] = await tx.select().from(slaPauses)
      .where(and(eq(slaPauses.cycleId, cycleId), isNull(slaPauses.resumedAt))).limit(1);
    return pause ?? null;
  }

  async function closedPauseMinutes(tx, cycleId) {
    const [row] = await tx
      .select({ total: sql`coalesce(sum(${slaPauses.businessMinutes}), 0)::int` })
      .from(slaPauses)
      .where(and(eq(slaPauses.cycleId, cycleId), isNotNull(slaPauses.resumedAt)));
    return Number(row.total);
  }

  async function insertMessage(tx, { ticketId, kind, actor, body, recipientUserId = null, at }) {
    const [message] = await tx.insert(messages).values({
      ticketId,
      kind,
      authorType: actor.type,
      authorUserId: actor.userId ?? null,
      authorCustomerId: actor.customerId ?? null,
      recipientUserId,
      body,
      createdAt: at,
    }).returning();
    return message;
  }

  async function startSlaCycle(tx, engine, ticket, cycleNo, isReopen, at) {
    const c = startCycle(engine, ticket.priority, at);
    const [cycle] = await tx.insert(slaCycles).values({
      ticketId: ticket.id,
      cycleNo,
      isReopen,
      startedAt: c.startedAt,
      clockStartAt: c.clockStartAt,
      priority: c.priority,
      replyBudgetMinutes: c.replyBudgetMinutes,
      resolveBudgetMinutes: c.resolveBudgetMinutes,
      replyDueAt: c.replyDueAt,
      resolveDueAt: c.resolveDueAt,
    }).returning();
    await logEvent(tx, {
      ticketId: ticket.id, type: 'sla_cycle_started', actor: SYSTEM,
      payload: { cycle_no: cycleNo, reply_due_at: iso(c.replyDueAt), resolve_due_at: iso(c.resolveDueAt) },
    });
    return cycle;
  }

  // Breach flags are written once. The background job (step 04) catches breaches while a ticket sits;
  // these two checks make sure a late reply or late resolve is recorded even if the job has not run.
  async function flagReplyBreach(tx, cycle, at, detectedBy) {
    if (cycle.replyBreachedAt || !isOverdue(cycle.replyDueAt, at)) return;
    await tx.update(slaCycles).set({ replyBreachedAt: at })
      .where(and(eq(slaCycles.id, cycle.id), isNull(slaCycles.replyBreachedAt)));
    await logEvent(tx, {
      ticketId: cycle.ticketId, type: 'reply_breached', actor: SYSTEM,
      payload: { due_at: iso(cycle.replyDueAt), detected_by: detectedBy },
    });
  }

  async function flagResolveBreach(tx, cycle, instant, at, detectedBy) {
    if (cycle.resolveBreachedAt || !isOverdue(cycle.resolveDueAt, instant)) return;
    await tx.update(slaCycles).set({ resolveBreachedAt: at })
      .where(and(eq(slaCycles.id, cycle.id), isNull(slaCycles.resolveBreachedAt)));
    await logEvent(tx, {
      ticketId: cycle.ticketId, type: 'resolve_breached', actor: SYSTEM,
      payload: { due_at: iso(cycle.resolveDueAt), detected_by: detectedBy },
    });
  }

  async function upsertCustomer(tx, name, email) {
    const clean = email.trim();
    await tx.insert(customers).values({ name, email: clean }).onConflictDoNothing();
    const [customer] = await tx.select().from(customers)
      .where(sql`lower(${customers.email}) = ${clean.toLowerCase()}`);
    return customer;
  }

  // Shared by "customer raises a ticket" and "customer writes after the reopen window".
  async function openTicket(tx, engine, at, { customer, subject, body, priority, parentTicketId = null }) {
    const token = newToken();
    const [ticket] = await tx.insert(tickets).values({
      customerId: customer.id, subject, priority, parentTicketId,
      accessTokenHash: hashToken(token), createdAt: at, updatedAt: at,
    }).returning();
    const message = await insertMessage(tx, {
      ticketId: ticket.id, kind: 'public', actor: customerActor(customer.id), body, at,
    });
    await logEvent(tx, {
      ticketId: ticket.id, type: 'ticket_created', actor: customerActor(customer.id), messageId: message.id,
      payload: { priority, body_sha256: bodyHash(body), ...(parentTicketId ? { parent_ticket_id: parentTicketId } : {}) },
    });
    await startSlaCycle(tx, engine, ticket, 1, false, at);
    return { ticket, token, message };
  }

  return {
    // ---------------------------------------------------------------- customer side
    async createTicket({ name, email, subject, body, priority = 'medium' }) {
      return inTx(async (tx, engine, at) => {
        const customer = await upsertCustomer(tx, name, email);
        const { ticket, token } = await openTicket(tx, engine, at, { customer, subject, body, priority });
        return { ticket, token };
      });
    },

    // One entry point for everything a customer writes. Outcome depends on the ticket's state:
    //   new / open            -> 'replied'
    //   waiting_on_customer   -> 'replied' and the SLA clock resumes
    //   resolved, in window   -> 'reopened' (new SLA cycle)
    //   resolved past window, or closed -> 'new_ticket' linked to the old one
    async customerMessage(token, body) {
      return inTx(async (tx, engine, at) => {
        const [found] = await tx.select({ id: tickets.id }).from(tickets)
          .where(eq(tickets.accessTokenHash, hashToken(token)));
        if (!found) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
        const ticket = await lockTicket(tx, found.id);
        const actor = customerActor(ticket.customerId);

        if (ticket.status === 'closed' || (ticket.status === 'resolved' && ticket.reopenUntil < at)) {
          const [customer] = await tx.select().from(customers).where(eq(customers.id, ticket.customerId));
          const subject = (ticket.subject.startsWith('Re: ') ? ticket.subject : `Re: ${ticket.subject}`).slice(0, 200);
          const opened = await openTicket(tx, engine, at, {
            customer, subject, body, priority: ticket.priority, parentTicketId: ticket.id,
          });
          const reason = ticket.status === 'closed' ? 'ticket_closed' : 'reopen_window_elapsed';
          await logEvent(tx, {
            ticketId: ticket.id, type: 'linked_ticket_created', actor,
            payload: { child_ticket_id: opened.ticket.id, reason },
          });
          await logEvent(tx, {
            ticketId: opened.ticket.id, type: 'linked_ticket_created', actor,
            payload: { parent_ticket_id: ticket.id, reason },
          });
          return { outcome: 'new_ticket', ticket: opened.ticket, token: opened.token };
        }

        const message = await insertMessage(tx, {
          ticketId: ticket.id, kind: 'public', actor, body, recipientUserId: ticket.assigneeId, at,
        });
        const hash = bodyHash(body);

        if (ticket.status === 'resolved') {                       // inside the reopen window
          const [last] = await tx.select({ n: slaCycles.cycleNo }).from(slaCycles)
            .where(eq(slaCycles.ticketId, ticket.id)).orderBy(desc(slaCycles.cycleNo)).limit(1);
          const cycleNo = last.n + 1;
          const [updated] = await tx.update(tickets).set({
            status: 'open', resolvedAt: null, reopenUntil: null, reopenCount: sql`${tickets.reopenCount} + 1`,
          }).where(and(eq(tickets.id, ticket.id), eq(tickets.status, 'resolved'))).returning();
          await logEvent(tx, { ticketId: ticket.id, type: 'customer_replied', actor, messageId: message.id,
            payload: { body_sha256: hash } });
          await logEvent(tx, { ticketId: ticket.id, type: 'reopened', actor,
            payload: { reopen_count: updated.reopenCount, cycle_no: cycleNo } });
          await logEvent(tx, { ticketId: ticket.id, type: 'status_changed', actor,
            payload: { from: 'resolved', to: 'open' } });
          await startSlaCycle(tx, engine, updated, cycleNo, true, at);
          return { outcome: 'reopened', ticket: updated };
        }

        if (ticket.status === 'waiting_on_customer') {            // the customer answered: resume the clock
          const cycle = await activeCycle(tx, ticket.id);
          const pause = await openPause(tx, cycle.id);
          const minutes = pause ? pausedMinutes(engine, pause.pausedAt, at) : 0;
          if (pause) {
            await tx.update(slaPauses).set({ resumedAt: at, businessMinutes: minutes })
              .where(eq(slaPauses.id, pause.id));
          }
          const totalPaused = await closedPauseMinutes(tx, cycle.id);
          const due = dueDates(engine, {
            clockStartAt: cycle.clockStartAt,
            replyBudgetMinutes: cycle.replyBudgetMinutes,
            resolveBudgetMinutes: cycle.resolveBudgetMinutes,
            pausedBusinessMinutes: totalPaused,
          });
          await tx.update(slaCycles).set({ resolveDueAt: due.resolveDueAt }).where(eq(slaCycles.id, cycle.id));
          const [updated] = await tx.update(tickets)
            .set({ status: 'open', waitingSince: null, autoCloseAt: null })
            .where(eq(tickets.id, ticket.id)).returning();
          await logEvent(tx, { ticketId: ticket.id, type: 'customer_replied', actor, messageId: message.id,
            payload: { body_sha256: hash, resumed_sla: true } });
          await logEvent(tx, { ticketId: ticket.id, type: 'sla_resumed', actor,
            payload: { business_minutes: minutes, resolve_due_at: iso(due.resolveDueAt) } });
          await logEvent(tx, { ticketId: ticket.id, type: 'status_changed', actor,
            payload: { from: 'waiting_on_customer', to: 'open' } });
          return { outcome: 'replied', ticket: updated };
        }

        await logEvent(tx, { ticketId: ticket.id, type: 'customer_replied', actor, messageId: message.id,
          payload: { body_sha256: hash } });
        return { outcome: 'replied', ticket };
      });
    },

    // ---------------------------------------------------------------- agent side
    // Claim: the race from INC-0291. The row lock plus the guarded UPDATE means one winner, one 409.
    async claimTicket(ticketId, user) {
      return inTx(async (tx, _engine, at) => {
        const ticket = await lockTicket(tx, ticketId);
        if (ticket.assigneeId) {
          const [owner] = await tx.select({ name: users.name }).from(users).where(eq(users.id, ticket.assigneeId));
          throw new HttpError(409, 'already_claimed', `Already claimed by ${owner?.name ?? 'another agent'}`);
        }
        if (!ACTIVE.includes(ticket.status)) {
          throw new HttpError(409, 'not_claimable', `A ${ticket.status} ticket cannot be claimed`);
        }
        const [updated] = await tx.update(tickets).set({
          assigneeId: user.id,
          claimedAt: at,
          status: sql`CASE WHEN ${tickets.status} = 'new' THEN 'open'::ticket_status ELSE ${tickets.status} END`,
        }).where(and(eq(tickets.id, ticketId), isNull(tickets.assigneeId), inArray(tickets.status, ACTIVE)))
          .returning();
        if (!updated) throw new HttpError(409, 'already_claimed', 'Already claimed by another agent');
        await logEvent(tx, { ticketId, type: 'claimed', actor: staffActor(user),
          payload: { status_after: updated.status } });
        return updated;
      });
    },

    // The owner, or a lead, can give a ticket back.
    async releaseTicket(ticketId, user) {
      return inTx(async (tx) => {
        const ticket = await lockTicket(tx, ticketId);
        if (!ticket.assigneeId) throw new HttpError(409, 'not_assigned', 'Ticket is not claimed');
        const byLead = user.role === 'lead' && ticket.assigneeId !== user.id;
        if (ticket.assigneeId !== user.id && user.role !== 'lead') {
          throw new HttpError(403, 'forbidden', 'Only the owner or a lead can release this ticket');
        }
        const [updated] = await tx.update(tickets).set({ assigneeId: null, claimedAt: null })
          .where(eq(tickets.id, ticketId)).returning();
        await logEvent(tx, { ticketId, type: 'released', actor: staffActor(user),
          payload: { from_user_id: ticket.assigneeId, by_lead: byLead } });
        return updated;
      });
    },

    async reassignTicket(ticketId, user, toUserId) {
      if (user.role !== 'lead') throw new HttpError(403, 'forbidden', 'Only a lead can reassign tickets');
      return inTx(async (tx, _engine, at) => {
        const ticket = await lockTicket(tx, ticketId);
        if (!ACTIVE.includes(ticket.status)) {
          throw new HttpError(409, 'not_claimable', `A ${ticket.status} ticket cannot be reassigned`);
        }
        const [target] = await tx.select().from(users).where(eq(users.id, toUserId));
        if (!target || !target.active) throw new HttpError(400, 'validation_error', 'Target agent not found or inactive');
        const [updated] = await tx.update(tickets).set({
          assigneeId: target.id,
          claimedAt: at,
          status: sql`CASE WHEN ${tickets.status} = 'new' THEN 'open'::ticket_status ELSE ${tickets.status} END`,
        }).where(eq(tickets.id, ticketId)).returning();
        await logEvent(tx, { ticketId, type: 'reassigned', actor: staffActor(user),
          payload: { from_user_id: ticket.assigneeId, to_user_id: target.id } });
        return updated;
      });
    },

    // Private team note (INC-0304). Any staff member can write one. It never touches the SLA.
    async addNote(ticketId, user, body) {
      return inTx(async (tx, _engine, at) => {
        await lockTicket(tx, ticketId);
        const message = await insertMessage(tx, {
          ticketId, kind: 'note', actor: staffActor(user), body, at,
        });
        await logEvent(tx, { ticketId, type: 'note_added', actor: staffActor(user), messageId: message.id,
          payload: { body_sha256: bodyHash(body) } });
        return message;
      });
    },

    // Public reply. Only the owner can send it. Only a public reply counts as the first response.
    async replyPublic(ticketId, user, { body, setWaiting = false }) {
      return inTx(async (tx, engine, at) => {
        const ticket = await lockTicket(tx, ticketId);
        if (ticket.assigneeId !== user.id) {
          throw ticket.assigneeId
            ? new HttpError(403, 'not_owner', 'Only the agent who owns this ticket can reply')
            : new HttpError(409, 'claim_required', 'Claim this ticket before replying');
        }
        if (ticket.status !== 'open' && ticket.status !== 'waiting_on_customer') {
          throw new HttpError(409, 'ticket_closed', `A ${ticket.status} ticket cannot be replied to`);
        }
        const actor = staffActor(user);
        const message = await insertMessage(tx, { ticketId, kind: 'public', actor, body, at });
        const cycle = await activeCycle(tx, ticketId);
        const isFirst = !cycle.firstResponseAt;
        await logEvent(tx, { ticketId, type: 'public_reply_sent', actor, messageId: message.id,
          payload: { body_sha256: bodyHash(body), first_response: isFirst } });

        if (isFirst) {
          await tx.update(slaCycles).set({ firstResponseAt: at, firstResponseMessageId: message.id })
            .where(eq(slaCycles.id, cycle.id));
          await flagReplyBreach(tx, cycle, at, 'reply');
        }

        let current = ticket;
        if (setWaiting && ticket.status === 'open') {
          [current] = await tx.update(tickets).set({
            status: 'waiting_on_customer', waitingSince: at, autoCloseAt: autoCloseAt(engine, at),
          }).where(eq(tickets.id, ticketId)).returning();
          await tx.insert(slaPauses).values({ cycleId: cycle.id, ticketId, pausedAt: at });
          await logEvent(tx, { ticketId, type: 'status_changed', actor,
            payload: { from: 'open', to: 'waiting_on_customer' } });
          await logEvent(tx, { ticketId, type: 'sla_paused', actor,
            payload: { auto_close_at: iso(current.autoCloseAt) } });
        }
        return { message, ticket: current };
      });
    },

    // Priority change (Meera's unanswered question). Same clock start, new budgets, recorded breaches stay.
    async setPriority(ticketId, user, newPriority) {
      return inTx(async (tx, engine) => {
        const ticket = await lockTicket(tx, ticketId);
        if (user.role !== 'lead' && ticket.assigneeId !== user.id) {
          throw new HttpError(403, 'forbidden', 'Only the owner or a lead can change the priority');
        }
        if (!ACTIVE.includes(ticket.status)) {
          throw new HttpError(409, 'ticket_closed', `A ${ticket.status} ticket cannot change priority`);
        }
        if (ticket.priority === newPriority) return ticket;
        const cycle = await activeCycle(tx, ticketId);
        const paused = await closedPauseMinutes(tx, cycle.id);
        const next = recomputeForPriority(engine, cycle, newPriority, paused);
        await tx.update(slaCycles).set({
          priority: next.priority,
          replyBudgetMinutes: next.replyBudgetMinutes,
          resolveBudgetMinutes: next.resolveBudgetMinutes,
          replyDueAt: next.replyDueAt,
          resolveDueAt: next.resolveDueAt,
        }).where(eq(slaCycles.id, cycle.id));
        const [updated] = await tx.update(tickets).set({ priority: newPriority })
          .where(eq(tickets.id, ticketId)).returning();
        await logEvent(tx, { ticketId, type: 'priority_changed', actor: staffActor(user), payload: {
          from: ticket.priority, to: newPriority,
          old_reply_due_at: iso(cycle.replyDueAt), new_reply_due_at: iso(next.replyDueAt),
          old_resolve_due_at: iso(cycle.resolveDueAt), new_resolve_due_at: iso(next.resolveDueAt),
        } });
        return updated;
      });
    },

    // Resolve: the owner marks it done. Starts the reopen window and ends the SLA cycle.
    async resolveTicket(ticketId, user) {
      return inTx(async (tx, engine, at) => {
        const ticket = await lockTicket(tx, ticketId);
        if (ticket.assigneeId !== user.id) {
          throw new HttpError(403, 'not_owner', 'Only the agent who owns this ticket can resolve it');
        }
        if (ticket.status !== 'open' && ticket.status !== 'waiting_on_customer') {
          throw new HttpError(409, 'ticket_closed', `A ${ticket.status} ticket cannot be resolved`);
        }
        const actor = staffActor(user);
        const cycle = await activeCycle(tx, ticketId);
        const pause = await openPause(tx, cycle.id);
        let judgedAt = at;                                   // time that counts against the SLA
        if (pause) {
          const minutes = pausedMinutes(engine, pause.pausedAt, at);
          await tx.update(slaPauses).set({ resumedAt: at, businessMinutes: minutes })
            .where(eq(slaPauses.id, pause.id));
          await logEvent(tx, { ticketId, type: 'sla_resumed', actor,
            payload: { business_minutes: minutes, reason: 'resolved' } });
          judgedAt = pause.pausedAt;                         // waiting time is not Arvo's fault
        }
        if (!cycle.firstResponseAt) await flagReplyBreach(tx, cycle, at, 'resolve');
        await flagResolveBreach(tx, cycle, judgedAt, at, 'resolve');
        await tx.update(slaCycles).set({ resolvedAt: at, endedAt: at }).where(eq(slaCycles.id, cycle.id));
        const until = reopenUntil(engine, at);
        const [updated] = await tx.update(tickets).set({
          status: 'resolved', resolvedAt: at, reopenUntil: until, waitingSince: null, autoCloseAt: null,
        }).where(eq(tickets.id, ticketId)).returning();
        await logEvent(tx, { ticketId, type: 'resolved', actor, payload: { reopen_until: iso(until) } });
        await logEvent(tx, { ticketId, type: 'status_changed', actor,
          payload: { from: ticket.status, to: 'resolved' } });
        return updated;
      });
    },
  };
}
```

```js ref=server/services/queries.js
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  agentTicketList, customerMessages, customerTickets, customers, messages,
  slaCycles, slaPauses, ticketEvents, tickets, users,
} from '../../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { formatTicketNo, iso } from '../lib/format.js';
import { hashToken } from '../lib/tokens.js';
import { dbClock } from './tickets.js';

const ACTIVE = ['new', 'open', 'waiting_on_customer'];
export const LIST_VIEWS = ['open', 'mine', 'unclaimed', 'waiting', 'late', 'resolved', 'all'];

// Read side. Agent reads use `db`. Customer reads use `customerDb`, which in production can be a
// connection that is ONLY allowed to read the two customer_* views (see db/migrations/0002).
export function createQueries({ db, customerDb = db, clock = dbClock }) {
  return {
    // ----- agent: ticket list. Metadata only. NO message text is selected anywhere in this query. -----
    async listTickets(user, view) {
      const v = agentTicketList;
      const filters = {
        open: inArray(v.status, ACTIVE),
        mine: and(eq(v.assigneeId, user.id), inArray(v.status, ACTIVE)),
        unclaimed: eq(v.isUnclaimed, true),
        waiting: eq(v.isWaiting, true),
        late: and(inArray(v.status, ACTIVE), or(eq(v.replyLate, true), eq(v.resolveLate, true))),
        resolved: eq(v.status, 'resolved'),
        all: undefined,
      };
      const rows = await db
        .select({
          id: v.id, ticketNo: v.ticketNo, subject: v.subject, priority: v.priority, status: v.status,
          assigneeId: v.assigneeId, assigneeName: users.name, customerName: customers.name,
          isWaiting: v.isWaiting, isUnclaimed: v.isUnclaimed, replyLate: v.replyLate, resolveLate: v.resolveLate,
          nextDueAt: v.nextDueAt, replyDueAt: v.replyDueAt, resolveDueAt: v.resolveDueAt,
          waitingSince: v.waitingSince, autoCloseAt: v.autoCloseAt, reopenUntil: v.reopenUntil,
          createdAt: v.createdAt, updatedAt: v.updatedAt,
        })
        .from(v)
        .innerJoin(customers, eq(customers.id, v.customerId))
        .leftJoin(users, eq(users.id, v.assigneeId))
        .where(filters[view])
        .orderBy(sql`(${v.replyLate} OR ${v.resolveLate}) DESC`, sql`${v.nextDueAt} ASC NULLS LAST`, asc(v.id));

      return rows.map((r) => ({
        id: r.id,
        ticketNo: formatTicketNo(r.ticketNo),
        subject: r.subject,
        priority: r.priority,
        status: r.status,
        customerName: r.customerName,
        assignee: r.assigneeId ? { id: r.assigneeId, name: r.assigneeName } : null,
        isMine: r.assigneeId === user.id,
        isUnclaimed: r.isUnclaimed,
        isWaiting: r.isWaiting,
        isLate: r.replyLate || r.resolveLate,
        replyLate: r.replyLate,
        resolveLate: r.resolveLate,
        nextDueAt: iso(r.nextDueAt),
        replyDueAt: iso(r.replyDueAt),
        resolveDueAt: iso(r.resolveDueAt),
        waitingSince: iso(r.waitingSince),
        autoCloseAt: iso(r.autoCloseAt),
        reopenUntil: iso(r.reopenUntil),
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
      }));
    },

    // ----- agent: one ticket with the FULL thread (notes included), the audit timeline and SLA state -----
    async getAgentTicket(id) {
      const [row] = await db
        .select({ ticket: tickets, customerName: customers.name, customerEmail: customers.email, assigneeName: users.name })
        .from(tickets)
        .innerJoin(customers, eq(customers.id, tickets.customerId))
        .leftJoin(users, eq(users.id, tickets.assigneeId))
        .where(eq(tickets.id, id));
      if (!row) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
      const t = row.ticket;

      const authorUser = users;
      const thread = await db
        .select({
          id: messages.id, kind: messages.kind, authorType: messages.authorType, body: messages.body,
          createdAt: messages.createdAt, recipientUserId: messages.recipientUserId,
          staffName: authorUser.name, customerName: customers.name,
        })
        .from(messages)
        .leftJoin(authorUser, eq(authorUser.id, messages.authorUserId))
        .leftJoin(customers, eq(customers.id, messages.authorCustomerId))
        .where(eq(messages.ticketId, id))
        .orderBy(asc(messages.createdAt), asc(messages.id));

      const timeline = await db
        .select({
          chainSeq: ticketEvents.chainSeq, type: ticketEvents.type, actorType: ticketEvents.actorType,
          messageId: ticketEvents.messageId, payload: ticketEvents.payload, createdAt: ticketEvents.createdAt,
          staffName: users.name, customerName: customers.name,
        })
        .from(ticketEvents)
        .leftJoin(users, eq(users.id, ticketEvents.actorUserId))
        .leftJoin(customers, eq(customers.id, ticketEvents.actorCustomerId))
        .where(eq(ticketEvents.ticketId, id))
        .orderBy(asc(ticketEvents.chainSeq));

      const cycles = await db.select().from(slaCycles).where(eq(slaCycles.ticketId, id)).orderBy(asc(slaCycles.cycleNo));
      const pauses = await db.select().from(slaPauses).where(eq(slaPauses.ticketId, id)).orderBy(asc(slaPauses.id));
      const [flags] = await db.select({ replyLate: agentTicketList.replyLate, resolveLate: agentTicketList.resolveLate })
        .from(agentTicketList).where(eq(agentTicketList.id, id));

      return {
        ticket: {
          id: t.id, ticketNo: formatTicketNo(t.ticketNo), subject: t.subject, priority: t.priority, status: t.status,
          customer: { id: t.customerId, name: row.customerName, email: row.customerEmail },
          assignee: t.assigneeId ? { id: t.assigneeId, name: row.assigneeName } : null,
          parentTicketId: t.parentTicketId, reopenCount: t.reopenCount,
          waitingSince: iso(t.waitingSince), autoCloseAt: iso(t.autoCloseAt),
          resolvedAt: iso(t.resolvedAt), reopenUntil: iso(t.reopenUntil), closedAt: iso(t.closedAt),
          closedReason: t.closedReason, createdAt: iso(t.createdAt), updatedAt: iso(t.updatedAt),
          isLate: Boolean(flags?.replyLate || flags?.resolveLate),
        },
        messages: thread.map((m) => ({
          id: m.id, kind: m.kind, authorType: m.authorType,
          authorName: m.authorType === 'staff' ? m.staffName : m.authorType === 'customer' ? m.customerName : 'Frontdesk',
          body: m.body, createdAt: iso(m.createdAt),
        })),
        events: timeline.map((e) => ({
          seq: e.chainSeq, type: e.type, actorType: e.actorType,
          actorName: e.actorType === 'staff' ? e.staffName : e.actorType === 'customer' ? e.customerName : 'System',
          messageId: e.messageId, payload: e.payload, createdAt: iso(e.createdAt),
        })),
        sla: {
          cycles: cycles.map((c) => ({
            cycleNo: c.cycleNo, isReopen: c.isReopen, priority: c.priority,
            startedAt: iso(c.startedAt), clockStartAt: iso(c.clockStartAt),
            replyDueAt: iso(c.replyDueAt), resolveDueAt: iso(c.resolveDueAt),
            firstResponseAt: iso(c.firstResponseAt), resolvedAt: iso(c.resolvedAt),
            replyBreachedAt: iso(c.replyBreachedAt), resolveBreachedAt: iso(c.resolveBreachedAt),
          })),
          pauses: pauses.map((p) => ({
            pausedAt: iso(p.pausedAt), resumedAt: iso(p.resumedAt), businessMinutes: p.businessMinutes,
          })),
        },
      };
    },

    async listUsers() {
      const rows = await db.select({ id: users.id, name: users.name, role: users.role, active: users.active })
        .from(users).orderBy(asc(users.name));
      return rows;
    },

    // ----- customer: ONLY the customer_* views, and every field is whitelisted by hand -----
    async getCustomerTicket(token) {
      const hash = hashToken(token);
      const [t] = await customerDb.select().from(customerTickets).where(eq(customerTickets.accessTokenHash, hash));
      if (!t) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
      const thread = await customerDb
        .select({
          id: customerMessages.id, authorType: customerMessages.authorType, authorName: customerMessages.authorName,
          body: customerMessages.body, createdAt: customerMessages.createdAt,
        })
        .from(customerMessages)
        .where(eq(customerMessages.accessTokenHash, hash))
        .orderBy(asc(customerMessages.createdAt), asc(customerMessages.id));
      const now = await clock(customerDb);
      return {
        ticketNo: formatTicketNo(t.ticketNo),
        subject: t.subject,
        status: t.status,
        createdAt: iso(t.createdAt),
        resolvedAt: iso(t.resolvedAt),
        reopenUntil: iso(t.reopenUntil),
        closedAt: iso(t.closedAt),
        canReopen: t.status === 'resolved' && t.reopenUntil != null && t.reopenUntil >= now,
        messages: thread.map((m) => ({
          id: m.id, authorType: m.authorType, authorName: m.authorName, body: m.body, createdAt: iso(m.createdAt),
        })),
      };
    },
  };
}
```

```js ref=server/middleware/auth.js
import { and, eq } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { SESSION_COOKIE, parseCookies, verifySession } from '../lib/session.js';

// Loads req.user from the session cookie (if any). It never rejects by itself.
// The user is re-read from the database on every request, so deactivating a user takes effect at once.
export function loadSession({ db, secret }) {
  return async (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = verifySession(token, secret);
    if (session) {
      const [user] = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role })
        .from(users).where(and(eq(users.id, session.uid), eq(users.active, true)));
      if (user) req.user = user;
    }
    next();
  };
}

export function requireAgent(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'unauthenticated', 'Please sign in'));
  next();
}

export function requireLead(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'unauthenticated', 'Please sign in'));
  if (req.user.role !== 'lead') return next(new HttpError(403, 'forbidden', 'Only a lead can do this'));
  next();
}

// Cross-site request forgery guard for the cookie session: a browser always sends Origin on
// cross-site POSTs. If it is present, it must be this site.
export function sameOrigin(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* malformed origin */ }
    if (host !== req.get('host')) return next(new HttpError(403, 'cross_origin_blocked', 'Cross-origin request blocked'));
  }
  next();
}
```

```js ref=server/routes/auth.js
import bcrypt from 'bcryptjs';
import express from 'express';
import { sql } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { SESSION_MAX_AGE_S, signSession, sessionCookie } from '../lib/session.js';
import { requireEmail, requireString } from '../lib/validate.js';
import { requireAgent } from '../middleware/auth.js';

// Compared against when the email is unknown, so "no such user" and "wrong password" take the same time.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

export function authRoutes({ db, secret, secureCookies }) {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    const email = requireEmail(req.body?.email);
    const password = requireString(req.body?.password, 'password', { max: 200 });
    const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.active || !matches) {
      throw new HttpError(401, 'invalid_credentials', 'Wrong email or password');   // same answer for both cases
    }
    const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S;
    res.setHeader('Set-Cookie', sessionCookie(signSession({ uid: user.id, exp }, secret), { secure: secureCookies }));
    res.json({ user: publicUser(user) });
  });

  router.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', sessionCookie('', { maxAge: 0, secure: secureCookies }));
    res.status(204).end();
  });

  router.get('/me', requireAgent, (req, res) => res.json({ user: req.user }));

  return router;
}
```

```js ref=server/routes/agent.js
import express from 'express';
import { LIST_VIEWS } from '../services/queries.js';
import { formatTicketNo } from '../lib/format.js';
import { optionalBoolean, parseId, requireOneOf, requireString } from '../lib/validate.js';
import { requireAgent, requireLead } from '../middleware/auth.js';

const PRIORITIES = ['high', 'medium', 'low'];
const brief = (t) => ({
  id: t.id, ticketNo: formatTicketNo(t.ticketNo), status: t.status, priority: t.priority, assigneeId: t.assigneeId,
});

// Everything here requires a signed-in agent. Ownership rules are enforced in the service, not here.
export function agentRoutes({ svc, queries }) {
  const router = express.Router();
  router.use(requireAgent);

  router.get('/tickets', async (req, res) => {
    const view = requireOneOf(req.query.view ?? 'open', 'view', LIST_VIEWS);
    res.json({ tickets: await queries.listTickets(req.user, view) });
  });

  router.get('/tickets/:id', async (req, res) => {
    res.json(await queries.getAgentTicket(parseId(req.params.id)));
  });

  router.post('/tickets/:id/claim', async (req, res) => {
    res.json({ ticket: brief(await svc.claimTicket(parseId(req.params.id), req.user)) });
  });

  router.post('/tickets/:id/release', async (req, res) => {
    res.json({ ticket: brief(await svc.releaseTicket(parseId(req.params.id), req.user)) });
  });

  router.post('/tickets/:id/reassign', async (req, res) => {
    const toUserId = parseId(req.body?.userId);
    res.json({ ticket: brief(await svc.reassignTicket(parseId(req.params.id), req.user, toUserId)) });
  });

  router.post('/tickets/:id/replies', async (req, res) => {
    const body = requireString(req.body?.body, 'body');
    const setWaiting = optionalBoolean(req.body?.setWaiting, 'setWaiting');
    const { message, ticket } = await svc.replyPublic(parseId(req.params.id), req.user, { body, setWaiting });
    res.status(201).json({ messageId: message.id, ticket: brief(ticket) });
  });

  router.post('/tickets/:id/notes', async (req, res) => {
    const message = await svc.addNote(parseId(req.params.id), req.user, requireString(req.body?.body, 'body'));
    res.status(201).json({ messageId: message.id });
  });

  router.patch('/tickets/:id/priority', async (req, res) => {
    const priority = requireOneOf(req.body?.priority, 'priority', PRIORITIES);
    res.json({ ticket: brief(await svc.setPriority(parseId(req.params.id), req.user, priority)) });
  });

  router.post('/tickets/:id/resolve', async (req, res) => {
    res.json({ ticket: brief(await svc.resolveTicket(parseId(req.params.id), req.user)) });
  });

  router.get('/users', requireLead, async (_req, res) => {
    res.json({ users: await queries.listUsers() });
  });

  return router;
}
```

```js ref=server/routes/customer.js
import express from 'express';
import { HttpError } from '../lib/errors.js';
import { formatTicketNo } from '../lib/format.js';
import { requireEmail, requireOneOf, requireString } from '../lib/validate.js';

const PRIORITIES = ['high', 'medium', 'low'];

// No login here. The secret token in the URL IS the credential (only its hash is stored).
// Responses are built from hand-picked fields: nothing internal can ride along by accident.
export function customerRoutes({ svc, queries }) {
  const router = express.Router();

  // "Raise a ticket". The customer picks how bad it is; an agent can change it later.
  router.post('/tickets', async (req, res) => {
    const input = {
      name: requireString(req.body?.name, 'name', { max: 100 }),
      email: requireEmail(req.body?.email),
      subject: requireString(req.body?.subject, 'subject', { max: 200 }),
      body: requireString(req.body?.body, 'body'),
      priority: requireOneOf(req.body?.priority ?? 'medium', 'priority', PRIORITIES),
    };
    const { ticket, token } = await svc.createTicket(input);
    // The only time the raw token exists outside the customer's link.
    res.status(201).json({ token, link: `/t/${token}`, ticket: { ticketNo: formatTicketNo(ticket.ticketNo) } });
  });

  router.get('/tickets/:token', async (req, res) => {
    res.json(await queries.getCustomerTicket(req.params.token));
  });

  router.post('/tickets/:token/messages', async (req, res) => {
    const body = requireString(req.body?.body, 'body');
    const result = await svc.customerMessage(req.params.token, body);
    const out = { outcome: result.outcome, ticketNo: formatTicketNo(result.ticket.ticketNo) };
    if (result.outcome === 'new_ticket') {            // the customer needs the NEW ticket's link
      out.token = result.token;
      out.link = `/t/${result.token}`;
    }
    res.status(201).json(out);
  });

  router.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'No such API route')));
  return router;
}
```

```js ref=server/app.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { sql } from 'drizzle-orm';
import { loadSession, sameOrigin } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { agentRoutes } from './routes/agent.js';
import { customerRoutes } from './routes/customer.js';
import { loadEngineConfig } from './lib/engineConfig.js';
import { createTicketService } from './services/tickets.js';
import { createQueries } from './services/queries.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// A factory (not a singleton) so tests can build an app around a throwaway database and a fake clock.
//   db          main connection (agents, writes)
//   customerDb  connection used ONLY for customer reads. Can be a view-only DB role. Defaults to db.
//   getEngine   async () => engine. Default re-reads settings/holidays/policies on every write,
//               so holiday edits apply immediately.
//   clock       async (tx) => Date. Default is the database clock.
export function createApp({
  db,
  customerDb = db,
  getEngine = () => loadEngineConfig(db),
  clock,
  sessionSecret = 'dev-only-secret',   // server/index.js always passes the real secret
  secureCookies = false,
  clientDir = path.resolve(here, '../client/dist'),
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(sameOrigin);
  app.use(loadSession({ db, secret: sessionSecret }));

  const svc = createTicketService({ db, getEngine, ...(clock ? { clock } : {}) });
  const queries = createQueries({ db, customerDb, ...(clock ? { clock } : {}) });

  app.get('/api/health', async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ ok: true, db: 'up', time: new Date().toISOString() });
    } catch (err) {
      console.error('health check failed:', err.cause?.message ?? err.message);
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  app.use('/api/auth', authRoutes({ db, secret: sessionSecret, secureCookies }));
  app.use('/api/agent', agentRoutes({ svc, queries }));
  app.use('/api/customer', customerRoutes({ svc, queries }));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such API route' } });
  });

  // Production: Express also serves the built React app (one deployable service).
  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  // Last: never leak SQL or stack traces to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    let status = err.status ?? 500;
    let code = typeof err.code === 'string' && status < 500 ? err.code : 'internal_error';
    if (err.type === 'entity.parse.failed') { status = 400; code = 'invalid_json'; }
    if (status >= 500) console.error(err.cause?.message ?? err.stack ?? err);
    res.status(status).json({
      error: {
        code,
        message: status < 500 ? (code === 'invalid_json' ? 'Request body is not valid JSON' : err.message) : 'Something went wrong',
      },
    });
  });

  return app;
}
```

```js ref=server/index.js
import { config } from './config.js';
import { createPool, createDb } from '../db/client.js';
import { createApp } from './app.js';

const pool = createPool();
const db = createDb(pool);

// Optional: a separate connection whose DB user can ONLY read the customer views (migration 0002).
const customerPool = config.customerDatabaseUrl ? createPool(config.customerDatabaseUrl) : null;
const customerDb = customerPool ? createDb(customerPool) : db;

const app = createApp({
  db,
  customerDb,
  sessionSecret: config.sessionSecret,
  secureCookies: config.isProd,
});

const server = app.listen(config.port, () => {
  console.log(`Frontdesk API listening on :${config.port} (${config.env})`);
});

// Step 04 starts the SLA background job here (every config.tickIntervalMs).

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => Promise.all([pool.end(), customerPool?.end()]).then(() => process.exit(0)));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

