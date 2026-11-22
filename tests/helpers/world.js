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
