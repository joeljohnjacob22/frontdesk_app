# Plan 04: Background Job and Exports

## Purpose and handoff interpretation

The handoff identifies **Document 04: Background job and exports** as the next deliverable. This plan follows that workflow: build and verify a reference implementation, then produce a Copilot instruction document from it. It does not begin implementation until the user approves the scope.

The reference implementation will be developed in a clean verification copy based on `docs/handoff/project/`, not by treating that bundled project as the user's repository. The deliverable will be `docs/COPILOT_04_BACKGROUND_JOB_AND_EXPORTS.md`.

## Current baseline

- Steps 01–03 have a reference implementation and 109 passing tests.
- The database already has the required ticket, SLA, pause, message, event, and customer-view structures.
- `ticket_events` already permits `reply_breached`, `resolve_breached`, `auto_closed`, `closed`, `status_changed`, and `export_generated`.
- The existing customer views exclude notes; the optional `CUSTOMER_DATABASE_URL` can use the view-only role.
- The handoff's remaining-work design is in `docs/handoff/HANDOFF.md`, section 7. The database query patterns are in `docs/handoff/docs/DB_Implement.MD`, sections 6–7.

## Proposed scope

### Background tick

1. Add an exported, directly testable tick operation in `server/jobs/tick.js`; inject the engine and a fixed `Date` for tests.
2. Process each ticket in its own transaction and lock its ticket row using `FOR UPDATE SKIP LOCKED`, so concurrent workers skip work already locked by another request or worker.
3. Record an overdue reply breach once when the active cycle has no first response, the ticket is not waiting, and its reply deadline has passed.
4. Record an overdue resolve breach once when the active cycle's resolve deadline has passed and the ticket is not waiting.
5. Auto-close waiting tickets at `auto_close_at <= now`: close the open pause, end the cycle, clear waiting fields, set the closed reason/time, and log `auto_closed` and `status_changed` in the same transaction.
6. Close resolved tickets at `reopen_until <= now`, setting the close fields and logging `closed`.
7. Keep each transition idempotent, update guarded breach flags only once, and use existing engine functions for business-time pause accounting.
8. Start the job from `server/index.js` using `TICK_INTERVAL_MS`; prevent overlapping runs in one process, log failures, and stop the interval during shutdown. The database row locks remain the cross-process safety mechanism.

### CSV and JSON exports

1. Add an export service with explicit field lists and formatters; do not export whole database rows.
2. Agent exports may include notes only when `include_notes=true`; default it to false. Customer exports contain only customer-safe ticket fields and public messages from `customer_tickets` and `customer_messages`.
3. Keep customer reads on `customerDb` and the two customer views only. If a customer export is audited, write its `export_generated` event through the privileged application database without widening customer read permissions.
4. Write one `export_generated` event per exported ticket with only `{ format, include_notes }`; never put message text in the event.
5. Protect CSV consumers from formula injection by prefixing cells whose first character is `=`, `+`, `-`, or `@` with an apostrophe, and quote/escape CSV fields correctly.
6. Add thin authenticated agent and token-authorized customer export routes. Return JSON or CSV with appropriate content type and attachment filename.
7. Do not add a PDF dependency or PDF format.

## Proposed API shape (approval requested)

- `GET /api/agent/tickets/:id/export?format=json|csv&include_notes=false|true`
- `GET /api/customer/tickets/:token/export?format=json|csv`

The agent route requires a session. The customer route uses the ticket token as its credential. Unknown customer tokens retain the existing non-enumerating `404 ticket_not_found` response. Exports are for one ticket at a time; list/bulk exports and pagination are out of scope.

Proposed contents:

- Agent: hand-picked ticket metadata and ordered thread entries; omit notes by default, include them only when requested. Do not include token hashes, password hashes, or event-chain hashes.
- Customer: hand-picked customer ticket fields and the public thread only; no notes, staff-only identifiers, customer email, priority, SLA details, or audit events.

## Test-first and verification sequence

1. Review the existing schema, append-only trigger behavior, service interfaces, and locked Step 01–03 tests in the clean verification copy.
2. Write locked tick tests first: each breach once across repeated runs; deadlines checked at and after the boundary; waiting tickets excluded from breach detection; auto-close and resolved close update all required fields and events atomically; waiting duration is accounted for; locked rows are skipped.
3. Write export tests first: JSON/CSV shapes, include-notes default and opt-in, CSV formula-injection and quoting cases, one audit event per export, no body in events, and sentinel-based customer privacy checks using the restricted database role.
4. Implement the job, scheduling, export service, and routes using existing helpers and database structures. Avoid migrations and dependencies unless a test demonstrates they are required.
5. Run the existing 109-test suite plus new tests under the normal timezone and `America/Los_Angeles`; check for warnings and preserve all current tests.
6. Mutation-test the new behavior (including removing `SKIP LOCKED`, removing breach guards, exposing notes, and omitting CSV escaping) and ensure each mutation is caught.
7. Generate `docs/COPILOT_04_BACKGROUND_JOB_AND_EXPORTS.md` with context, decisions, file-by-file steps, locked tests, verification commands, acceptance criteria, troubleshooting, out-of-scope items, and a reference implementation.
8. Extract the document into a clean copy and rerun its full test and timezone checks before presenting it as complete.

## Decisions to record after approval

- Tick interval defaults to 60 seconds and is configurable by `TICK_INTERVAL_MS`.
- A deadline is due at equality (`deadline <= now`).
- Customer exports expose only the existing public customer-view fields and messages.
- Agent exports omit notes by default; explicit opt-in includes them.
- CSV and JSON are supported; PDF is excluded.
- CSV formula-leading cells are apostrophe-prefixed.
- Export audit events record the format and note-inclusion flag, never message text.

## Out of scope

- PDF export, bulk export, list pagination, UI work, email delivery, new schema objects, and new dependencies.
- Reworking the existing ticket lifecycle or changing the Step 01–03 locked tests.
- Committing generated implementation code to the active user repository before the approved scope is clear.

## Approval gate

**Approved by the user.** Proceed with the handoff workflow: develop and test the reference implementation in an isolated copy, then produce and verify `docs/COPILOT_04_BACKGROUND_JOB_AND_EXPORTS.md`. Do not apply Step 04 runtime code to the active application repository as part of this document-writing step.
