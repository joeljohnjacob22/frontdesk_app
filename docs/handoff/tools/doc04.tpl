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
@@FILE tests/tick.test.js@@
```

```js file=tests/exports.test.js
@@FILE tests/exports.test.js@@
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

@@REFS@@
