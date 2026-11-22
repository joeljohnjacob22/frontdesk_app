import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers/testDb.js';

const ctx = await createTestDb();
test.after(() => ctx.drop());
const names = async (query) => (await ctx.pool.query(query)).rows.map((r) => Object.values(r)[0]).sort();

test('all 10 tables exist', async () => {
  const got = await names(`SELECT table_name FROM information_schema.tables
                           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  assert.deepEqual(got, ['customers', 'holidays', 'messages', 'settings', 'sla_cycles',
    'sla_pauses', 'sla_policies', 'ticket_events', 'tickets', 'users']);
});

test('the 3 views exist', async () => {
  const got = await names(`SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`);
  assert.deepEqual(got, ['agent_ticket_list', 'customer_messages', 'customer_tickets']);
});

test('append-only and chain triggers exist', async () => {
  const got = await names(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`);
  for (const t of ['messages_no_update', 'messages_no_delete', 'messages_no_truncate',
    'ticket_events_no_update', 'ticket_events_no_delete', 'ticket_events_no_truncate',
    'ticket_events_chain_bi', 'tickets_no_delete', 'tickets_updated_at', 'users_updated_at']) {
    assert.ok(got.includes(t), `missing trigger ${t}`);
  }
});

test('helper functions exist', async () => {
  const got = await names(`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                           WHERE n.nspname = 'public'`);
  for (const f of ['compute_event_hash', 'verify_ticket_chain', 'ticket_events_chain',
    'forbid_modification', 'set_updated_at']) {
    assert.ok(got.includes(f), `missing function ${f}`);
  }
});

test('seed data: policies, settings, holidays', async () => {
  const count = async (t) => (await ctx.pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  assert.equal(await count('sla_policies'), 3);
  assert.equal(await count('settings'), 6);
  assert.equal(await count('holidays'), 4);
  const { rows } = await ctx.pool.query(`SELECT value FROM settings WHERE key = 'work_start'`);
  assert.equal(rows[0].value, '09:30');
});

test('migrations are idempotent', async () => {
  const { runMigrations } = await import('../db/migrate.js');
  await runMigrations(ctx.pool);   // second run must be a no-op, not an error
});
