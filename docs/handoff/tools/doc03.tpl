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
@@FILE tests/helpers/world.js@@
```

**Authentication tests**

```js file=tests/auth.test.js
@@FILE tests/auth.test.js@@
```

**Lifecycle tests** (claim race, waiting and resume, priority, resolve, reopen, linked tickets, audit trail). IST times from the step 02 cheat sheet: Fri 20 Nov 2026, Mon 23, Wed 25, Fri 27, Mon 30.

```js file=tests/lifecycle.test.js
@@FILE tests/lifecycle.test.js@@
```

**Agent API tests**

```js file=tests/agentApi.test.js
@@FILE tests/agentApi.test.js@@
```

**Customer API tests**

```js file=tests/customerApi.test.js
@@FILE tests/customerApi.test.js@@
```

**Privacy tests (INC-0304).** The last two tests run every customer read through a database role that can read **only** the two customer views. If any customer code path touched a table, it would fail with `permission denied`. They are skipped only if the `frontdesk_customer_reader` role does not exist (a host that refused `0002`).

```js file=tests/privacy.test.js
@@FILE tests/privacy.test.js@@
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
@@FILE docs/smoke.sh@@
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

@@REFS@@
