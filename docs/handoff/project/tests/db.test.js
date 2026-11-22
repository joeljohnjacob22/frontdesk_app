import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { and, eq, isNull, inArray, sql } from 'drizzle-orm';
import * as s from '../db/schema.js';
import { createTestDb } from './helpers/testDb.js';
import { rejectsPg } from './helpers/assertions.js';

const ctx = await createTestDb();
const { db } = ctx;
test.after(() => ctx.drop());

const sha = (x) => crypto.createHash('sha256').update(x).digest();
const token = crypto.randomBytes(16).toString('hex');
let ticketId;

test.before(async () => {
  await db.insert(s.users).values([
    { name: 'A1', email: 'a1@x', passwordHash: 'h' },
    { name: 'A2', email: 'a2@x', passwordHash: 'h' },
  ]);
  const [customer] = await db.insert(s.customers).values({ name: 'Cust', email: 'c@x' }).returning();
  const [ticket] = await db.insert(s.tickets)
    .values({ customerId: customer.id, subject: 'Help', accessTokenHash: sha(token) }).returning();
  ticketId = ticket.id;
  const [agent] = await db.select().from(s.users).where(eq(s.users.email, 'a1@x'));
  await db.insert(s.messages).values([
    { ticketId, kind: 'note', authorType: 'staff', authorUserId: agent.id, body: 'SECRET-SENTINEL' },
    { ticketId, kind: 'public', authorType: 'customer', authorCustomerId: customer.id, body: 'hello' },
  ]);
});

test('INC-0291: two simultaneous claims, exactly one wins', async () => {
  const agents = await db.select().from(s.users);
  const claim = (userId) => db.update(s.tickets)
    .set({
      assigneeId: userId,
      claimedAt: sql`now()`,
      status: sql`CASE WHEN ${s.tickets.status} = 'new' THEN 'open'::ticket_status ELSE ${s.tickets.status} END`,
    })
    .where(and(eq(s.tickets.id, ticketId), isNull(s.tickets.assigneeId),
      inArray(s.tickets.status, ['new', 'open', 'waiting_on_customer'])))
    .returning({ id: s.tickets.id });
  const results = await Promise.all(agents.map((a) => claim(a.id)));
  assert.equal(results.filter((r) => r.length === 1).length, 1);
});

test('INC-0304: the customer view never contains a note', async () => {
  const rows = await db.select().from(s.customerMessages)
    .where(eq(s.customerMessages.accessTokenHash, sha(token)));
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes('SECRET-SENTINEL'));
});

test('INC-0304: a customer cannot author a note', async () => {
  const [customer] = await db.select().from(s.customers);
  await rejectsPg(db.insert(s.messages).values({
    ticketId, kind: 'note', authorType: 'customer', authorCustomerId: customer.id, body: 'x',
  }), /messages_note_staff_only/);
});

test('INC-0318: history is append-only and chained', async () => {
  await rejectsPg(db.update(s.messages).set({ body: 'x' }), /append-only/);
  await Promise.all([...Array(8)].map((_, i) =>
    db.insert(s.ticketEvents).values({
      ticketId, type: 'status_changed', actorType: 'system', payload: { i }, hash: Buffer.alloc(0),
    })));
  // Rows exist now, so the row-level DELETE trigger fires.
  await rejectsPg(db.delete(s.ticketEvents), /append-only/);
  const r = await db.execute(
    sql`SELECT count(*)::int n, bool_and(ok) ok, max(chain_seq) mx FROM verify_ticket_chain(${ticketId})`);
  assert.deepEqual(r.rows[0], { n: 8, ok: true, mx: 8 });
});

test('INC-0318: an event may not carry a message body', async () => {
  await rejectsPg(db.insert(s.ticketEvents).values({
    ticketId, type: 'note_added', actorType: 'system', payload: { body: 'leak' }, hash: Buffer.alloc(0),
  }), /ticket_events_payload_chk/);
});

test('status shape is enforced by the database', async () => {
  await rejectsPg(
    db.update(s.tickets).set({ status: 'waiting_on_customer' }).where(eq(s.tickets.id, ticketId)),
    /tickets_waiting_fields/);
});
