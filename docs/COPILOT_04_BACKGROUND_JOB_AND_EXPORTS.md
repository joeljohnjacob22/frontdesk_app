# COPILOT 04: Background Job and Exports

**Project:** Frontdesk (Arvo Systems hiring test). **Previous steps:** 01 setup and migrations, 02 business-time and SLA engine, and 03 authentication and ticket lifecycle API. The Step 03 reference suite has 109 passing tests.

| # | Document | Delivers |
|---|---|---|
| 01 | Setup and migrations | Repo, DB, seed, skeleton, test harness (**done**) |
| 02 | Business-time and SLA engine | Pure time module, due-date maths (**done**) |
| 03 | Auth and ticket lifecycle API | Login, ticket actions, customer view, audit and privacy (**done**) |
| **04** | **Background job and exports (this file)** | SLA breach detection, automatic ticket closing, per-ticket CSV/JSON exports |
| 05 | Agent UI and customer page | React screens |
| 06 | Deploy and README | Hosting, README, "what I did not finish" note |

---

## 0. What this step adds

Step 03 records a breach when an agent replies or resolves a ticket after its deadline. This step handles deadlines that pass while nobody is working on the ticket:

- A scheduled tick records an overdue first reply or resolution once.
- A ticket waiting on the customer auto-closes when its five-business-day window expires.
- A resolved ticket closes when its one-week reopen window expires.
- Staff can download one ticket as JSON or CSV. Team notes are omitted unless an agent explicitly asks to include them.
- Customers can download a safe copy of their own ticket and public conversation through their secret ticket link.

**Tests in §5 are locked.** Add them before the implementation, confirm they fail for the missing Step 04 behavior, and never edit them to make the implementation pass. Existing tests from Steps 01–03 must stay unchanged. Use the reference appendix only if stuck.

**No schema changes and no new npm dependencies.** `TICK_INTERVAL_MS` already exists from Step 01; its default is 60,000 ms.

## 1. Decisions to append to `docs/DECISIONS.md`

Add these rows using the current date and the existing table format:

| Decision | Reason |
|---|---|
| The tick starts immediately and then runs every `TICK_INTERVAL_MS` (60 seconds by default); one process skips overlapping runs, and database row locks coordinate multiple processes. | Background deadlines must progress without waiting for another ticket request. |
| A deadline is due at equality: `deadline <= now`. | Apply a transition as soon as its deadline is reached. |
| Waiting tickets auto-close at `auto_close_at`; resolved tickets close at `reopen_until`. | Give both one-week rules a precise, testable boundary. |
| Customer exports use an explicit customer-safe field list and public messages only. Agent exports omit notes unless `include_notes=true`. | INC-0304 applies to exports as well as screens and API responses. |
| Export one ticket at a time as JSON or CSV; PDF and bulk exports are out of scope. | Keep the take-home scope small and avoid document-generation dependencies. |
| CSV output quotes every field, doubles embedded quotes, and apostrophe-prefixes formula-leading cells, including formulas preceded by leading ASCII whitespace. | Avoid malformed CSV and spreadsheet formula execution. |
| Each successful export writes an `export_generated` event containing only its format and note-inclusion flag. | Keep an audit record without copying message content into the event chain. |

## 2. Tick behavior

`runTick(db, engine, now)` is directly callable by tests. It uses the supplied `Date`; the scheduled runner obtains the engine and one database-clock time per run. Do not call `new Date()` or `Date.now()` in the job.

For each candidate ticket, open a separate transaction, lock the ticket row with `FOR UPDATE SKIP LOCKED`, then re-read the current ticket and active SLA cycle before changing anything. Use the existing `pausedMinutes` engine helper; do not add date or business-calendar arithmetic here. Write each state change and its audit events in the same transaction.

| Candidate | Required guard | Atomic result |
|---|---|---|
| Reply breach | Ticket status is `new` or `open`; active cycle has no first response or prior reply breach; `reply_due_at <= now`. | Set `reply_breached_at` once and log `reply_breached { due_at, detected_by: 'tick' }`. |
| Resolve breach | Ticket status is `new` or `open`; active cycle has no prior resolve breach; `resolve_due_at <= now`. Waiting tickets are excluded. | Set `resolve_breached_at` once and log `resolve_breached { due_at, detected_by: 'tick' }`. |
| Waiting auto-close | Status is `waiting_on_customer`; `auto_close_at <= now`. | Set status `closed`, `closed_reason='customer_no_reply'`, `closed_at=now`; clear `waiting_since` and `auto_close_at`; close the open pause and active SLA cycle; log `auto_closed` and `status_changed`. |
| Resolved close | Status is `resolved`; `reopen_until <= now`. | Set status `closed`, `closed_reason='resolution_window_elapsed'`, `closed_at=now`; log `closed`. |

Use the system actor for tick events. The breach flag update must have an `IS NULL` guard, and its event must only be written when that guarded update returns a row. A tick repeated for the same time must not duplicate state changes or events. If required related state is missing (for example, a waiting ticket has no open pause), fail the transaction and log the server-side error rather than silently pretending success.

The scheduler runs one tick immediately and repeats at the configured interval. It must not overlap ticks in the same process, must log failures, and must expose a stop function that clears the timer and awaits in-flight work. `SKIP LOCKED` is still required: the in-process guard does not coordinate separate server processes.

## 3. Export contracts

### Agent export

`GET /api/agent/tickets/:id/export?format=json|csv&include_notes=true|false`

- Requires the same signed-in agent session as other `/api/agent` routes.
- `format` defaults to `json`; `include_notes` defaults to `false`.
- The JSON contains a hand-picked ticket object and ordered messages. It may contain customer and staff names/email, but never token hashes, password hashes, or event-chain hashes.
- With the default, include only public messages. `include_notes=true` explicitly includes notes with their `kind`.
- The CSV has one row per message, or one metadata-only row when the ticket has no messages. Quote every value and double every embedded quote.
- A nonexistent ticket returns the normal `404 ticket_not_found`.

### Customer export

`GET /api/customer/tickets/:token/export?format=json|csv`

- The token in the URL is the credential; unknown tokens return the existing non-enumerating `404 ticket_not_found`.
- `format` defaults to `json`.
- Build returned content only from explicit fields in `customer_tickets` and `customer_messages`, using `customerDb`. Do not read message bodies from `messages`, and do not return notes, `kind`, customer email, priority, assignee, SLA details, or audit data.
- The export audit actor is attributed using a privileged lookup in the main database after the customer-view data is loaded. That lookup is for the audit event only; it must not supply any response content or widen the customer's database-role permissions.

Both routes return an attachment with `application/json` or `text/csv` content type and a `ticket-FD-####.<format>` filename. CSV cells beginning with `=`, `+`, `-`, or `@`, including when preceded by whitespace or ASCII control characters, must be prefixed with an apostrophe before quoting. Never place message text in the `export_generated` payload; log only `{ format, include_notes }`.

## 4. Files

```
server/
  jobs/tick.js                 (new: one tick and scheduled runner)
  services/exports.js          (new: JSON/CSV shaping and audit event)
  routes/agent.js              (add authenticated agent export endpoint)
  routes/customer.js           (add token-authorized customer export endpoint)
  app.js                       (wire the export service into both route factories)
  index.js                     (start the tick and stop it during shutdown)
tests/
  tick.test.js                 (new, locked)
  exports.test.js              (new, locked)
docs/DECISIONS.md              (append the Step 04 decisions)
```

## 5. Steps

### Step 1: Add the locked tests first

These tests use the Step 03 helper world and real throwaway PostgreSQL databases. Add both files exactly as provided; do not alter any earlier test.

```js file=tests/tick.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { tickets } from '../db/schema.js';
import { runTick, startTickJob } from '../server/jobs/tick.js';
import { createWorld } from './helpers/world.js';

const world = await createWorld();
test.after(async () => { await world.drop(); });

test('reply breach is recorded once at the deadline', async () => {
  const { ticket } = await world.newTicket({ priority: 'high' });
  const [cycle] = await world.cycles(ticket.id);

  await runTick(world.db, world.engine, cycle.replyDueAt);
  await runTick(world.db, world.engine, cycle.replyDueAt);

  const [after] = await world.cycles(ticket.id);
  assert.equal(after.replyBreachedAt.getTime(), cycle.replyDueAt.getTime());
  const events = await world.events(ticket.id);
  assert.equal(events.filter((event) => event.type === 'reply_breached').length, 1);
  assert.deepEqual(events.find((event) => event.type === 'reply_breached').payload, {
    due_at: cycle.replyDueAt.toISOString(),
    detected_by: 'tick',
  });
});

test('waiting tickets are not marked breached while the SLA clock is paused', async () => {
  world.clock.set('2026-11-23 10:00');
  const { ticket } = await world.claimed({ priority: 'medium' });
  await world.svc.replyPublic(ticket.id, world.agent, {
    body: 'Please provide more information.',
    setWaiting: true,
  });
  const cycle = await world.cycle(ticket.id);

  await runTick(world.db, world.engine, new Date(cycle.resolveDueAt.getTime() + 1));

  const after = await world.cycle(ticket.id);
  assert.equal(after.resolveBreachedAt, null);
  assert.ok(!(await world.eventTypes(ticket.id)).includes('resolve_breached'));
  assert.equal((await world.ticket(ticket.id)).status, 'waiting_on_customer');
});

test('waiting tickets auto-close at the exact deadline and close the pause and cycle', async () => {
  world.clock.set('2026-11-23 10:00');
  const { ticket } = await world.claimed({ priority: 'high' });
  await world.svc.replyPublic(ticket.id, world.agent, {
    body: 'Can you confirm the account name?',
    setWaiting: true,
  });
  const before = await world.ticket(ticket.id);
  const now = before.autoCloseAt;

  await runTick(world.db, world.engine, now);
  await runTick(world.db, world.engine, now);

  const after = await world.ticket(ticket.id);
  assert.equal(after.status, 'closed');
  assert.equal(after.closedReason, 'customer_no_reply');
  assert.equal(after.closedAt.getTime(), now.getTime());
  assert.equal(after.waitingSince, null);
  assert.equal(after.autoCloseAt, null);
  const [pause] = await world.pauses(ticket.id);
  assert.equal(pause.resumedAt.getTime(), now.getTime());
  assert.notEqual(pause.businessMinutes, null);
  const [cycle] = await world.cycles(ticket.id);
  assert.equal(cycle.endedAt.getTime(), now.getTime());
  const events = await world.events(ticket.id);
  assert.equal(events.filter((event) => event.type === 'auto_closed').length, 1);
  assert.equal(events.filter((event) => event.type === 'status_changed').length, 2);
});

test('waiting tickets auto-close when the tick runs just after the deadline', async () => {
  world.clock.set('2026-11-23 10:00');
  const { ticket } = await world.claimed({ priority: 'high' });
  await world.svc.replyPublic(ticket.id, world.agent, {
    body: 'Please confirm the account name.',
    setWaiting: true,
  });
  const before = await world.ticket(ticket.id);
  const now = new Date(before.autoCloseAt.getTime() + 60_000);

  await runTick(world.db, world.engine, now);

  const after = await world.ticket(ticket.id);
  assert.equal(after.status, 'closed');
  assert.equal(after.closedAt.getTime(), now.getTime());
  const [pause] = await world.pauses(ticket.id);
  assert.equal(pause.resumedAt.getTime(), now.getTime());
});

test('resolved tickets close at the reopen deadline', async () => {
  world.clock.set('2026-11-23 10:00');
  const { ticket } = await world.claimed();
  await world.svc.resolveTicket(ticket.id, world.agent);
  const resolved = await world.ticket(ticket.id);

  await runTick(world.db, world.engine, resolved.reopenUntil);

  const after = await world.ticket(ticket.id);
  assert.equal(after.status, 'closed');
  assert.equal(after.closedReason, 'resolution_window_elapsed');
  assert.equal(after.closedAt.getTime(), resolved.reopenUntil.getTime());
  assert.ok((await world.eventTypes(ticket.id)).includes('closed'));
});

test('tick skips a ticket whose row is locked by another transaction', async () => {
  const { ticket } = await world.newTicket({ priority: 'high' });
  const [cycle] = await world.cycles(ticket.id);
  let releaseLock;
  let signalLocked;
  const locked = new Promise((resolve) => { signalLocked = resolve; });
  const hold = new Promise((resolve) => { releaseLock = resolve; });

  const lockTransaction = world.db.transaction(async (tx) => {
    await tx.select({ id: tickets.id }).from(tickets)
      .where(eq(tickets.id, ticket.id))
      .for('update');
    signalLocked();
    await hold;
  });
  await locked;
  try {
    await runTick(world.db, world.engine, cycle.replyDueAt);
    const [unchanged] = await world.cycles(ticket.id);
    assert.equal(unchanged.replyBreachedAt, null);
  } finally {
    releaseLock();
    await lockTransaction;
  }

  await runTick(world.db, world.engine, cycle.replyDueAt);
  const [after] = await world.cycles(ticket.id);
  assert.ok(after.replyBreachedAt);
});

test('each tick writes state and events without changing unrelated tickets', async () => {
  const first = await world.newTicket({ email: 'tick-one@example.com', priority: 'high' });
  const [firstCycle] = await world.cycles(first.ticket.id);
  world.clock.setMs(firstCycle.replyDueAt.getTime() + 30 * 86_400_000);
  const second = await world.newTicket({ email: 'tick-two@example.com', priority: 'high' });

  await runTick(world.db, world.engine, firstCycle.replyDueAt);

  const [firstAfter] = await world.cycles(first.ticket.id);
  const [secondAfter] = await world.cycles(second.ticket.id);
  assert.ok(firstAfter.replyBreachedAt);
  assert.equal(secondAfter.replyBreachedAt, null);
});

test('scheduler runs immediately, avoids overlapping ticks, and stops cleanly', async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let stop;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    stop = startTickJob({
      db: world.db,
      getEngine: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(45);
        active -= 1;
        return world.engine;
      },
      intervalMs: 20,
      clock: async () => new Date('1970-01-01T00:00:00Z'),
      logger: { error: assert.fail },
    });
    assert.equal(calls, 1);
    await delay(130);
    await stop();
    const callsWhenStopped = calls;
    await delay(60);
    assert.ok(callsWhenStopped >= 2);
    assert.equal(maxActive, 1);
    assert.equal(calls, callsWhenStopped);
  } finally {
    if (stop) await stop();
  }
});
```

```js file=tests/exports.test.js
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
```

**Verify (expected RED):** `node --test tests/tick.test.js tests/exports.test.js` fails because the Step 04 job, service, and export routes are not implemented yet. Do not change the tests or create placeholders to hide the failure.

### Step 2: Implement the tick job

Create `server/jobs/tick.js` with an exported `runTick(db, engine, now)` and `startTickJob({ db, getEngine, intervalMs, clock, logger })`.

1. Select candidate ticket IDs whose current status/deadline indicates one of the four rows in §2. Avoid selecting message bodies.
2. Process every candidate in its own transaction. Lock the ticket first using `.for('update', { skipLocked: true })`; re-check status and deadlines under that lock.
3. Use guarded `UPDATE ... WHERE ... IS NULL ... RETURNING` statements for breach flags. Log the event only for a changed row.
4. For waiting auto-close, update the ticket, close the currently open pause using `pausedMinutes(engine, pausedAt, now)`, end the active cycle, and append both required events in the same transaction. A missing pause or active cycle is an error that rolls the transaction back.
5. For resolved close, update the guarded status and close fields before logging `closed`.
6. Make repeated ticks idempotent. Return a small summary if useful, but do not change the public API to expose it.
7. Implement an immediate initial run, interval scheduling, same-process overlap prevention, failure logging, and an awaited stop function. Use the injected clock so tests do not depend on wall-clock dates.

**Verify:** `node --test tests/tick.test.js` passes, including exact-deadline, just-after, repeat-tick, waiting-exclusion, and locked-row cases.

### Step 3: Implement exports

Create `server/services/exports.js` and add a thin route to each existing route module.

1. Validate formats (`csv` or `json`) and the optional agent `include_notes` value. Invalid values return `400 validation_error`.
2. Agent export: lock and load the ticket; build a hand-written metadata object and an ordered thread. Filter notes out by default; include them only for explicit opt-in.
3. Customer export: use `customerDb` and only `customer_tickets` plus `customer_messages` for all response fields. Keep its explicit output field list independent from the database row shape.
4. For CSV, emit a header row and rows; quote every cell, double embedded quotes, and prefix formula-leading values before quoting.
5. Write one `export_generated` event per successful export with the appropriate staff/customer actor and only the format and note-inclusion flag. Agent data and the export event must be in the same transaction. The privileged customer lookup is only for audit attribution.
6. Return only `{ body, contentType, filename }` from the service. Routes set `Content-Type` and `Content-Disposition`; do not put SQL/business logic into routes.

**Verify:** `node --test tests/exports.test.js` passes. Confirm the restricted customer-role test can export without permission to read base tables.

### Step 4: Wire startup and shutdown

Update the Express factory to create the export service and pass it to the agent/customer route factories. In `server/index.js`, start the scheduler with `config.tickIntervalMs`, `loadEngineConfig(db)`, and the default database clock. During shutdown, close the HTTP server, stop and await the scheduler, then close the database pools. Do not start background work in the app factory: tests create apps without starting a timer.

**Verify:** `node --test tests/health.test.js tests/agentApi.test.js tests/customerApi.test.js tests/exports.test.js` passes.

### Step 5: Full verification, smoke, and commit

Run the full test suite in both timezones. Tests must use their throwaway databases; do not run a reset against a non-disposable database.

```bash
npm test
TZ=America/Los_Angeles npm test
```

Run the existing lifecycle smoke test against a disposable, seeded database and running server:

```bash
bash docs/smoke.sh
```

Append the Step 04 decision rows to `docs/DECISIONS.md`. Check that no existing tests were edited and no schema, migration, package, or lockfile changes were made. Then make the commit:

```bash
git add -A
git commit -m "step 4: background tick and ticket exports"
```

## 6. Acceptance checklist

| # | Check | Expected |
|---|---|---|
| 1 | `npm test` | **123 pass**, 0 fail (109 from Steps 01–03 plus 14 Step 04 tests) |
| 2 | `TZ=America/Los_Angeles npm test` | Same result |
| 3 | Test output | No `DeprecationWarning` |
| 4 | `bash docs/smoke.sh` on a running disposable server | Ends with `ALL SMOKE CHECKS PASSED` |
| 5 | Existing tests | Only the two new Step 04 test files are added; earlier test files are unchanged |
| 6 | Tick locking | Every ticket transaction uses `FOR UPDATE SKIP LOCKED`; the locked-row test passes |
| 7 | Breach events | Each breach flag is guarded and its event is written once with no body text |
| 8 | Customer privacy | Customer content reads only `customer_tickets` and `customer_messages`; restricted-role export test passes |
| 9 | Note handling | Agent export omits notes by default and includes them only on explicit opt-in; customer export has no notes |
| 10 | CSV | Embedded quotes are doubled and formula-leading values, including tab-prefixed values, are neutralized |
| 11 | Schema/dependencies | No migration, schema, package, or lockfile changes |
| 12 | `docs/DECISIONS.md` | Includes all seven Step 04 decisions |

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| A breach is written twice | The flag update or event insert is not guarded by the same successful `UPDATE ... RETURNING`. | Lock the ticket, add the `IS NULL` guard, and log only when the update returns a row. |
| Waiting ticket gets a resolve breach | Waiting tickets were included in the live SLA statuses. | Breach detection applies only to `new` and `open`; waiting tickets are paused. |
| Ticket does not close exactly at its deadline | Used `<` instead of `<=`, or only checked candidate selection and not the locked-row recheck. | Use `deadline <= now` in both places. |
| A tick hangs while another worker holds a ticket | Missing `SKIP LOCKED`. | Use `.for('update', { skipLocked: true })` on the per-ticket lock. |
| Ticket closes but its pause/cycle remains open | State updates were split across transactions or one related row was not updated. | Update ticket, pause, cycle, and events together in the ticket transaction. |
| Customer export fails with permission denied | The export read a base table through `customerDb`. | Read response content only through the two customer views; use the main DB only for the audit actor lookup. |
| Customer export contains internal fields | A whole view row was serialized instead of an explicit response object. | Build the customer output from a hand-written allowlist. |
| Agent export leaks a team note by default | Missing or inverted `include_notes` filtering. | Default to public messages and include notes only when the validated query is `true`. |
| A spreadsheet treats CSV data as a formula | Formula characters were not prefixed before CSV quoting. | Prefix dangerous leading values with an apostrophe, then quote and escape the cell. |
| Tests keep the process alive | The scheduler was started from `createApp`, or its timer was not stopped/unreferenced. | Start it only in `server/index.js`; expose a stop function and unref the interval. |

## 8. Out of scope

- PDF, bulk, or paginated exports.
- Email delivery, notification scheduling, or UI export buttons.
- Schema/migration changes or new dependencies.
- Reworking Step 03 write-time breach checks or customer lifecycle behavior.

## Appendix: reference implementation (use ONLY if Copilot is stuck)

The following files are the verified reference. Read them after attempting the implementation and compare one behavior at a time; do not replace the tests or unrelated Step 03 code wholesale.

```js ref=server/jobs/tick.js
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from 'drizzle-orm';
import { slaCycles, slaPauses, tickets } from '../../db/schema.js';
import { pausedMinutes } from '../lib/sla.js';
import { dbClock } from '../services/tickets.js';
import { logEvent, SYSTEM } from '../services/events.js';

const LIVE_STATUSES = ['new', 'open'];

async function findCandidates(db, now) {
  return db.selectDistinct({ id: tickets.id })
    .from(tickets)
    .leftJoin(slaCycles, and(
      eq(slaCycles.ticketId, tickets.id),
      isNull(slaCycles.endedAt),
    ))
    .where(or(
      and(
        eq(tickets.status, 'waiting_on_customer'),
        lte(tickets.autoCloseAt, now),
      ),
      and(
        eq(tickets.status, 'resolved'),
        lte(tickets.reopenUntil, now),
      ),
      and(
        inArray(tickets.status, LIVE_STATUSES),
        isNotNull(slaCycles.id),
        isNull(slaCycles.firstResponseAt),
        isNull(slaCycles.replyBreachedAt),
        lte(slaCycles.replyDueAt, now),
      ),
      and(
        inArray(tickets.status, LIVE_STATUSES),
        isNotNull(slaCycles.id),
        isNull(slaCycles.resolveBreachedAt),
        lte(slaCycles.resolveDueAt, now),
      ),
    ))
    .orderBy(asc(tickets.id));
}

async function closeWaitingTicket(tx, engine, ticket, cycle, now) {
  const [closed] = await tx.update(tickets).set({
    status: 'closed',
    closedAt: now,
    closedReason: 'customer_no_reply',
    waitingSince: null,
    autoCloseAt: null,
    updatedAt: now,
  }).where(and(
    eq(tickets.id, ticket.id),
    eq(tickets.status, 'waiting_on_customer'),
    lte(tickets.autoCloseAt, now),
  )).returning();
  if (!closed) return false;

  const [pause] = await tx.select().from(slaPauses)
    .where(and(eq(slaPauses.cycleId, cycle.id), isNull(slaPauses.resumedAt)))
    .for('update');
  if (!pause) throw new Error(`Waiting ticket ${ticket.id} has no open SLA pause`);

  const duration = pausedMinutes(engine, pause.pausedAt, now);
  await tx.update(slaPauses).set({
    resumedAt: now,
    businessMinutes: duration,
  }).where(eq(slaPauses.id, pause.id));
  const [endedCycle] = await tx.update(slaCycles).set({ endedAt: now })
    .where(and(eq(slaCycles.id, cycle.id), isNull(slaCycles.endedAt)))
    .returning({ id: slaCycles.id });
  if (!endedCycle) throw new Error(`SLA cycle ${cycle.id} ended during auto-close`);

  await logEvent(tx, {
    ticketId: ticket.id,
    type: 'auto_closed',
    actor: SYSTEM,
    payload: { reason: 'customer_no_reply' },
  });
  await logEvent(tx, {
    ticketId: ticket.id,
    type: 'status_changed',
    actor: SYSTEM,
    payload: { from: 'waiting_on_customer', to: 'closed' },
  });
  return true;
}

async function closeResolvedTicket(tx, ticket, now) {
  const [closed] = await tx.update(tickets).set({
    status: 'closed',
    closedAt: now,
    closedReason: 'resolution_window_elapsed',
    updatedAt: now,
  }).where(and(
    eq(tickets.id, ticket.id),
    eq(tickets.status, 'resolved'),
    lte(tickets.reopenUntil, now),
  )).returning();
  if (!closed) return false;

  await logEvent(tx, {
    ticketId: ticket.id,
    type: 'closed',
    actor: SYSTEM,
    payload: { reason: 'resolution_window_elapsed' },
  });
  return true;
}

async function recordBreaches(tx, ticket, cycle, now) {
  if (!LIVE_STATUSES.includes(ticket.status)) return false;
  let changed = false;

  if (cycle.firstResponseAt === null
      && cycle.replyBreachedAt === null
      && cycle.replyDueAt <= now) {
    const [updated] = await tx.update(slaCycles).set({ replyBreachedAt: now })
      .where(and(
        eq(slaCycles.id, cycle.id),
        isNull(slaCycles.endedAt),
        isNull(slaCycles.firstResponseAt),
        isNull(slaCycles.replyBreachedAt),
        lte(slaCycles.replyDueAt, now),
      ))
      .returning({ id: slaCycles.id });
    if (updated) {
      changed = true;
      await logEvent(tx, {
        ticketId: ticket.id,
        type: 'reply_breached',
        actor: SYSTEM,
        payload: { due_at: cycle.replyDueAt.toISOString(), detected_by: 'tick' },
      });
    }
  }

  if (cycle.resolveBreachedAt === null && cycle.resolveDueAt <= now) {
    const [updated] = await tx.update(slaCycles).set({ resolveBreachedAt: now })
      .where(and(
        eq(slaCycles.id, cycle.id),
        isNull(slaCycles.endedAt),
        isNull(slaCycles.resolveBreachedAt),
        lte(slaCycles.resolveDueAt, now),
      ))
      .returning({ id: slaCycles.id });
    if (updated) {
      changed = true;
      await logEvent(tx, {
        ticketId: ticket.id,
        type: 'resolve_breached',
        actor: SYSTEM,
        payload: { due_at: cycle.resolveDueAt.toISOString(), detected_by: 'tick' },
      });
    }
  }

  return changed;
}

async function processTicket(db, engine, ticketId, now) {
  return db.transaction(async (tx) => {
    const [ticket] = await tx.select().from(tickets)
      .where(eq(tickets.id, ticketId))
      .for('update', { skipLocked: true });
    if (!ticket) return 'skipped';

    if (ticket.status === 'waiting_on_customer' && ticket.autoCloseAt <= now) {
      const [cycle] = await tx.select().from(slaCycles)
        .where(and(eq(slaCycles.ticketId, ticket.id), isNull(slaCycles.endedAt)))
        .for('update');
      if (!cycle) throw new Error(`Waiting ticket ${ticket.id} has no active SLA cycle`);
      return await closeWaitingTicket(tx, engine, ticket, cycle, now) ? 'auto_closed' : 'unchanged';
    }

    if (ticket.status === 'resolved' && ticket.reopenUntil <= now) {
      return await closeResolvedTicket(tx, ticket, now) ? 'closed' : 'unchanged';
    }

    if (!LIVE_STATUSES.includes(ticket.status)) return 'unchanged';
    const [cycle] = await tx.select().from(slaCycles)
      .where(and(eq(slaCycles.ticketId, ticket.id), isNull(slaCycles.endedAt)))
      .for('update');
    if (!cycle) throw new Error(`Active ticket ${ticket.id} has no active SLA cycle`);
    return await recordBreaches(tx, ticket, cycle, now) ? 'breached' : 'unchanged';
  });
}

export async function runTick(db, engine, now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('runTick requires a valid Date');
  }
  const candidates = await findCandidates(db, now);
  const result = { candidates: candidates.length, processed: 0, skipped: 0, changed: 0 };
  for (const { id } of candidates) {
    const outcome = await processTicket(db, engine, id, now);
    if (outcome === 'skipped') result.skipped += 1;
    else {
      result.processed += 1;
      if (outcome !== 'unchanged') result.changed += 1;
    }
  }
  return result;
}

export function startTickJob({
  db,
  getEngine,
  intervalMs,
  clock = dbClock,
  logger = console,
}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError('Tick interval must be a positive integer');
  }

  let inFlight = null;
  const run = () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        await runTick(db, await getEngine(), await clock(db));
      } catch (error) {
        logger.error('SLA tick failed:', error.cause?.message ?? error.stack ?? error);
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  void run();

  return async function stopTickJob() {
    clearInterval(timer);
    if (inFlight) await inFlight;
  };
}
```

```js ref=server/services/exports.js
import { and, asc, eq } from 'drizzle-orm';
import {
  customerMessages,
  customerTickets,
  customers,
  messages,
  tickets,
  users,
} from '../../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { formatTicketNo, iso } from '../lib/format.js';
import { hashToken } from '../lib/tokens.js';
import { customerActor, logEvent, staffActor } from './events.js';

const CSV_FORMATS = new Set(['csv', 'json']);

function assertFormat(format) {
  if (!CSV_FORMATS.has(format)) {
    throw new HttpError(400, 'validation_error', 'format must be one of: csv, json');
  }
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

function csvDocument(headers, rows) {
  return [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
  ].join('\r\n');
}

function result(ticketNo, format, data, headers, rows) {
  const body = format === 'json' ? JSON.stringify(data) : csvDocument(headers, rows);
  return {
    body,
    contentType: format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
    filename: `ticket-${ticketNo}.${format}`,
  };
}

function authorName(message) {
  if (message.authorType === 'staff') return message.staffName;
  if (message.authorType === 'customer') return message.customerName;
  return 'Frontdesk';
}

function ticketMessage(message) {
  return {
    id: message.id,
    kind: message.kind,
    authorType: message.authorType,
    authorName: authorName(message),
    body: message.body,
    createdAt: iso(message.createdAt),
  };
}

async function loadAgentExport(tx, id, includeNotes) {
  const [ticket] = await tx.select().from(tickets)
    .where(eq(tickets.id, id))
    .for('update');
  if (!ticket) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
  const [[customer], [assignee]] = await Promise.all([
    tx.select({ name: customers.name, email: customers.email })
      .from(customers)
      .where(eq(customers.id, ticket.customerId)),
    ticket.assigneeId === null
      ? Promise.resolve([])
      : tx.select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.id, ticket.assigneeId)),
  ]);
  if (!customer) throw new Error(`Ticket ${id} has no customer`);

  const thread = await tx.select({
    id: messages.id,
    kind: messages.kind,
    authorType: messages.authorType,
    body: messages.body,
    createdAt: messages.createdAt,
    staffName: users.name,
    customerName: customers.name,
  })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(customers, eq(customers.id, messages.authorCustomerId))
    .where(eq(messages.ticketId, id))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  const visibleThread = thread
    .filter((message) => includeNotes || message.kind === 'public')
    .map(ticketMessage);
  const ticketNo = formatTicketNo(ticket.ticketNo);
  const data = {
    ticket: {
      id: ticket.id,
      ticketNo,
      subject: ticket.subject,
      priority: ticket.priority,
      status: ticket.status,
      customer: { name: customer.name, email: customer.email },
      assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
      createdAt: iso(ticket.createdAt),
      updatedAt: iso(ticket.updatedAt),
      waitingSince: iso(ticket.waitingSince),
      autoCloseAt: iso(ticket.autoCloseAt),
      resolvedAt: iso(ticket.resolvedAt),
      reopenUntil: iso(ticket.reopenUntil),
      closedAt: iso(ticket.closedAt),
      closedReason: ticket.closedReason,
    },
    messages: visibleThread,
  };
  const headers = [
    'ticketNo',
    'subject',
    'priority',
    'status',
    'customerName',
    'customerEmail',
    'assigneeName',
    'ticketCreatedAt',
    'messageId',
    'kind',
    'authorType',
    'authorName',
    'messageBody',
    'messageCreatedAt',
  ];
  const rows = visibleThread.length
    ? visibleThread.map((message) => ({
      ticketNo,
      subject: ticket.subject,
      priority: ticket.priority,
      status: ticket.status,
      customerName: customer.name,
      customerEmail: customer.email,
      assigneeName: assignee?.name,
      ticketCreatedAt: data.ticket.createdAt,
      messageId: message.id,
      kind: message.kind,
      authorType: message.authorType,
      authorName: message.authorName,
      messageBody: message.body,
      messageCreatedAt: message.createdAt,
    }))
    : [{
      ticketNo,
      subject: ticket.subject,
      priority: ticket.priority,
      status: ticket.status,
      customerName: customer.name,
      customerEmail: customer.email,
      assigneeName: assignee?.name,
      ticketCreatedAt: data.ticket.createdAt,
    }];

  return { ticket, data, headers, rows };
}

export function createExportService({ db, customerDb = db }) {
  return {
    async agentTicket(id, user, format, includeNotes = false) {
      assertFormat(format);
      return db.transaction(async (tx) => {
        const exported = await loadAgentExport(tx, id, includeNotes);
        await logEvent(tx, {
          ticketId: id,
          type: 'export_generated',
          actor: staffActor(user),
          payload: { format, include_notes: includeNotes },
        });
        return result(
          formatTicketNo(exported.ticket.ticketNo),
          format,
          exported.data,
          exported.headers,
          exported.rows,
        );
      });
    },

    async customerTicket(token, format) {
      assertFormat(format);
      const accessTokenHash = hashToken(token);
      const [ticket] = await customerDb.select({
        id: customerTickets.id,
        ticketNo: customerTickets.ticketNo,
        subject: customerTickets.subject,
        status: customerTickets.status,
        createdAt: customerTickets.createdAt,
        resolvedAt: customerTickets.resolvedAt,
        reopenUntil: customerTickets.reopenUntil,
        closedAt: customerTickets.closedAt,
      })
        .from(customerTickets)
        .where(eq(customerTickets.accessTokenHash, accessTokenHash));
      if (!ticket) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');

      const thread = await customerDb.select({
        authorType: customerMessages.authorType,
        authorName: customerMessages.authorName,
        body: customerMessages.body,
        createdAt: customerMessages.createdAt,
      })
        .from(customerMessages)
        .where(eq(customerMessages.accessTokenHash, accessTokenHash))
        .orderBy(asc(customerMessages.createdAt), asc(customerMessages.id));
      const ticketNo = formatTicketNo(ticket.ticketNo);
      const data = {
        ticketNo,
        subject: ticket.subject,
        status: ticket.status,
        createdAt: iso(ticket.createdAt),
        resolvedAt: iso(ticket.resolvedAt),
        reopenUntil: iso(ticket.reopenUntil),
        closedAt: iso(ticket.closedAt),
        messages: thread.map((message) => ({
          authorType: message.authorType,
          authorName: message.authorName,
          body: message.body,
          createdAt: iso(message.createdAt),
        })),
      };
      const headers = [
        'ticketNo',
        'subject',
        'status',
        'ticketCreatedAt',
        'resolvedAt',
        'reopenUntil',
        'closedAt',
        'authorType',
        'authorName',
        'messageBody',
        'messageCreatedAt',
      ];
      const rows = data.messages.length
        ? data.messages.map((message) => ({
          ticketNo,
          subject: ticket.subject,
          status: ticket.status,
          ticketCreatedAt: data.createdAt,
          resolvedAt: data.resolvedAt,
          reopenUntil: data.reopenUntil,
          closedAt: data.closedAt,
          authorType: message.authorType,
          authorName: message.authorName,
          messageBody: message.body,
          messageCreatedAt: message.createdAt,
        }))
        : [{
          ticketNo,
          subject: ticket.subject,
          status: ticket.status,
          ticketCreatedAt: data.createdAt,
          resolvedAt: data.resolvedAt,
          reopenUntil: data.reopenUntil,
          closedAt: data.closedAt,
        }];

      const [auditTicket] = await db.select({ customerId: tickets.customerId })
        .from(tickets)
        .where(and(eq(tickets.id, ticket.id), eq(tickets.accessTokenHash, accessTokenHash)));
      if (!auditTicket) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
      await db.transaction(async (tx) => logEvent(tx, {
        ticketId: ticket.id,
        type: 'export_generated',
        actor: customerActor(auditTicket.customerId),
        payload: { format, include_notes: false },
      }));

      return result(ticketNo, format, data, headers, rows);
    },
  };
}
```

```js ref=server/routes/agent.js
import express from 'express';
import { LIST_VIEWS } from '../services/queries.js';
import { formatTicketNo } from '../lib/format.js';
import { optionalBoolean, parseId, requireOneOf, requireString } from '../lib/validate.js';
import { requireAgent, requireLead } from '../middleware/auth.js';

const PRIORITIES = ['high', 'medium', 'low'];
const EXPORT_FORMATS = ['csv', 'json'];
const brief = (t) => ({
  id: t.id, ticketNo: formatTicketNo(t.ticketNo), status: t.status, priority: t.priority, assigneeId: t.assigneeId,
});

function sendExport(res, file) {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.body);
}

// Everything here requires a signed-in agent. Ownership rules are enforced in the service, not here.
export function agentRoutes({ svc, queries, exports }) {
  const router = express.Router();
  router.use(requireAgent);

  router.get('/tickets', async (req, res) => {
    const view = requireOneOf(req.query.view ?? 'open', 'view', LIST_VIEWS);
    res.json({ tickets: await queries.listTickets(req.user, view) });
  });

  router.get('/tickets/:id/export', async (req, res) => {
    const format = requireOneOf(req.query.format ?? 'json', 'format', EXPORT_FORMATS);
    const includeNotes = req.query.include_notes === undefined
      ? false
      : requireOneOf(req.query.include_notes, 'include_notes', ['true', 'false']) === 'true';
    const file = await exports.agentTicket(
      parseId(req.params.id),
      req.user,
      format,
      includeNotes,
    );
    sendExport(res, file);
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
const EXPORT_FORMATS = ['csv', 'json'];

// No login here. The secret token in the URL IS the credential (only its hash is stored).
// Responses are built from hand-picked fields: nothing internal can ride along by accident.
export function customerRoutes({ svc, queries, exports }) {
  const router = express.Router();

  router.get('/tickets/:token/export', async (req, res) => {
    const format = requireOneOf(req.query.format ?? 'json', 'format', EXPORT_FORMATS);
    const file = await exports.customerTicket(req.params.token, format);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.body);
  });

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
import { createExportService } from './services/exports.js';

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
  const exports = createExportService({ db, customerDb });

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
  app.use('/api/agent', agentRoutes({ svc, queries, exports }));
  app.use('/api/customer', customerRoutes({ svc, queries, exports }));

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
import { loadEngineConfig } from './lib/engineConfig.js';
import { startTickJob } from './jobs/tick.js';

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

const stopTickJob = startTickJob({
  db,
  getEngine: () => loadEngineConfig(db),
  intervalMs: config.tickIntervalMs,
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await stopTickJob();
    await Promise.all([pool.end(), customerPool?.end()]);
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

