# HANDOFF: Frontdesk hiring test, planning and instruction-writing project

**Written:** Sunday 22 Nov 2026 (the brief is dated 21 Nov 2026), by the previous Claude session, for whichever agent continues.
**Read in this order:** section 1 (resume prompt), 2 (the assignment), 4 (status), 7 (remaining work), 8 (working method). Everything else is reference.

---

## 1. Resume prompt (paste this to the next agent, with this whole bundle attached)

> You are taking over a project mid-way. Read `HANDOFF.md` fully, then `CHAT_HISTORY.md`, then skim `docs/`.
> **Context:** the user is a candidate doing a take-home hiring test ("Full Stack Developer", iNav Technologies / COLIGO).
> The test is a support-ticket system called **Frontdesk** for a fictional company, Arvo Systems. The user writes
> the code with **GitHub Copilot**. **Your job is NOT to write the whole app.** Your job is to plan, to write
> *step-by-step instruction documents* that Copilot follows, and to *verify* them by building and testing them yourself.
> **State:** Steps 04 and 05 are integrated into the active app. The approved customer-auth/UI improvements are
> also implemented: customer registration and RBAC, authenticated ticket access, a demo customer account outside
> production, and lead-issued temporary passwords. The client builds, 128 tests pass in two timezones, and browser
> plus disposable-database smoke checks passed. Deployment and README work remains; no deployment has been run.
> **Method:** follow HANDOFF section 8 exactly (build and test in a sandbox first, mutation-test, generate the document
> from the verified files, re-extract it into a clean project and re-run the suite). Do not hand over unverified code.
> **Tone:** warm, plain English, step by step. The user once said earlier phrasing came across "too bad"; be tactful and
> constructive. They asked for concepts to be explained simply when they did not understand something.
> First reply: confirm you have read the bundle, state in 3 lines where the project stands, and ask the user which of
> steps 02 and 03 Copilot has finished and whether anything failed.

---

## 2. The assignment (from the original brief, `docs/00_ORIGINAL_BRIEF_Hiring_Test.pdf`)

| Item | Detail |
|---|---|
| Role / company | Full Stack Developer test from iNav Technologies Pvt. Ltd, Kochi (document branded COLIGO). Dated 21-11-2026 |
| Time | "About 8 hours". They prefer 8 honest hours over a weekend of polish |
| Build | A working web app: a **backend service** and a **simple screen for support agents**. No requirements list: "it gives you a story, you must find the rules inside". No clarification list will be sent |
| Stack rules | Any frontend framework. **Node or Python** backend. **PostgreSQL or MySQL**. Everything else is free |
| Hosting | Put it online yourself (Render, Railway, Vercel, Fly.io, EC2, anything free) and **keep it running for one week** |
| Submit | (1) live URL, (2) repository link, (3) README explaining how to run locally, (4) a **short note answering: what did you not finish, and why?** ("Not knowing what you skipped is not [normal]") |

**The story:** Arvo Systems has 9 support agents and ~40 customer problems a day. They use a spreadsheet and WhatsApp. Last quarter ~1 in 5 problems was late and nobody could say which or why, because the spreadsheet keeps no history. They want "Frontdesk".

**Rules hidden in Meera's meeting notes (support lead):**

| Quote (paraphrased) | Rule |
|---|---|
| Reply/fix targets depend on severity | High ("cannot work at all"): reply 2 h, fix same working day. Medium: reply half a day, fix ~3 days. Low (questions, small requests): reply 1 day, fix ~1 week |
| Working hours 9:30 to 6:30, Mon to Fri, no weekends, no festival holidays | Clock counts **business time only**. A ticket arriving 6 PM Friday is not late Sunday morning |
| Waiting for the customer still counts against us ("not our fault") | **Pause the SLA clock** while waiting on the customer |
| No customer reply for ~1 working week | **Auto-close** |
| Customer unhappy after "done" | Can **reopen for ~1 week**, after that it is a **new ticket** |
| Agents need one screen | Their tickets, which are **late**, which are **waiting on customer**. Open a ticket: **reply to customer** or **write a team-only note** |
| "What happens to the timer if we change a ticket to urgent in the middle? Nobody knew." | **Unanswered on purpose.** The candidate must decide and document it |

**Incident reports (the reason the project was approved):**

| Incident | Requirement |
|---|---|
| INC-0291: two agents "took" the same ticket, sent conflicting replies | Only one agent can own a ticket. Enforce on the server |
| INC-0304: a private team note was sent to a customer (reported to the director) | Private notes **never** appear to a customer: "not on a screen, not in an API response, not in an export, not in a list" |
| INC-0318: customer said no reply until next morning, Arvo said 40 minutes, nobody could prove it | Record exactly what happened, when, and who did it. **Nobody can change that record later** |

---

## 3. People and preferences

- **The user** is the candidate. They write code with **GitHub Copilot** (Agent mode in VS Code). They want to understand the system, not just receive files.
- **Stack they chose:** Node.js (JavaScript, not TypeScript), Express, PostgreSQL, **Drizzle ORM**, React, Tailwind. They want the customer side built as a view too (customer link page).
- **They asked for:** step-by-step implementation; plain-English explanations when a concept was unclear (they did not understand sla_policies/sla_cycles/ticket_events/settings/access_token_hash until explained simply); detailed instructions Copilot can follow for "this entire operation".
- **Tone note:** after the first reply they said some phrasing of my corrections felt too harsh even though their notes were good. Keep corrections constructive.
- **Their original notes (turn 1)** had several ideas that were corrected (priority hours vs business time, auto-close rule, pause rule, reopen vs closed, "reply or reminder note" not in the brief, read receipts not in the brief). See `CHAT_HISTORY.md`.

---

## 4. Status board

| Step | Document | Written | Verified by Claude | User status |
|---|---|---|---|---|
| Plan | (in chat) | yes | n/a | agreed |
| DB design | `docs/DB_Implement.MD` (+ `docs/frontdesk-db_step01_original.zip`) | yes, rewritten for Drizzle | migrations applied on Postgres 16, behaviour tests passed | accepted |
| 01 | `docs/COPILOT_01_SETUP_AND_MIGRATIONS.md` | yes | extracted into a clean project: migrate x2, seed x2, tests, client build, production mode | **user reported done** ("that's done") |
| 02 | `docs/COPILOT_02_BUSINESS_TIME_AND_SLA_ENGINE.md` | yes | 25 new tests pass under 4 timezones, mutation-tested | **user said "I'll work on this"**. Completion unknown |
| 03 | `docs/COPILOT_03_AUTH_AND_TICKET_LIFECYCLE.md` | yes | clean extraction: 109/109 tests, no warnings, smoke script passed on a live server, mutation-tested | in progress or not started. **Ask the user** |
| 04 | `docs/COPILOT_04_BACKGROUND_JOB_AND_EXPORTS.md` | yes | active app: 123/123 tests in two timezones; live smoke passed; 10 reference mutations caught | integrated into active app |
| 05 | agent UI + customer page; plan at `docs/handoff/PLAN_05_AGENT_UI_AND_CUSTOMER_PAGE.md` | active app implemented; client build and browser smoke passed | | integrated into active app |
| Customer auth + welcoming UI | `docs/handoff/PLAN_CUSTOMER_AUTH_AND_UI_IMPROVEMENTS.md` | active app implemented; 128 tests pass in two timezones, client build and browser/smoke checks pass | | implemented and verified |
| 06 | deploy + README + closing note | **not written** | | |

`project/` in this bundle is the **verified reference implementation** (the code the documents were generated from). It is not the user's repo. The user's repo is whatever Copilot produced from the documents.

Test counts: step 01 = 14, step 02 adds 26 (total 40), step 03 adds 69 (total 109), step 04 adds 14 (total **123**).

---

## 5. Architecture in one page

**Stack:** Node >= 20.19, JavaScript ESM, Express 5, `pg` + Drizzle ORM, PostgreSQL 14+, React 19 + Vite 8 + Tailwind v4 + React Router 7 (`react-router-dom`), tests with `node:test`. Dependencies: `bcryptjs dotenv drizzle-orm express pg` (+ dev `concurrently drizzle-kit`). One deployable service: Express serves `client/dist`. `npm start` = migrate then serve.

**Layout:**
```
db/        schema.js (LOCKED)  migrations/ (LOCKED: 0000 generated, 0001 custom logic, 0002 optional roles)
           client.js migrate.js seed.js reset.js
server/    config.js app.js index.js
           lib/ calendar.js sla.js engineConfig.js (step 02)  errors format tokens validate session (step 03)
           services/ events.js tickets.js queries.js exports.js  jobs/tick.js
           middleware/auth.js   routes/ auth agent customer
tests/     helpers/ testDb time world assertions   + 13 test files
docs/      smoke.sh (+ DECISIONS.md, created by Copilot)
client/    Vite + React + Tailwind skeleton (real screens come in step 05)
```

**Tables (10):** `users`, `customers`, `tickets` (current state), `messages` (append-only; `kind` public/note), `ticket_events` (append-only, per-ticket SHA-256 hash chain), `sla_policies`, `sla_cycles` (one per SLA run; reopen = new cycle), `sla_pauses`, `holidays`, `settings`. **Views (3):** `customer_tickets`, `customer_messages` (excludes notes), `agent_ticket_list` (flags computed at read time).

**Ticket states:** `new -> open <-> waiting_on_customer -> resolved -> closed`. Reopen: `resolved -> open` (within window). Auto-close: `waiting_on_customer -> closed`.

**SLA semantics (engine, step 02):** working interval `[09:30, 18:30)` IST (UTC+5:30, fixed offset). Budgets in business minutes: High reply 120 / resolve same working day; Medium 270 / 1620; Low 540 / 2700. Due dates are persisted. Pauses add to the **resolve** deadline only. Priority change keeps the original clock start. Auto-close and reopen windows = 2700 business minutes (5 working days).

**Privacy design (INC-0304), four layers:** (1) notes are separate rows (`kind='note'`), (2) customer reads only via `customer_messages`/`customer_tickets` views, (3) optional DB role `frontdesk_customer_reader` that can read only those views (`CUSTOMER_DATABASE_URL`), (4) hand-whitelisted response fields plus tests that scan every customer response, list and error for a note sentinel.

**Audit design (INC-0318):** server/database sets all timestamps (`clock_timestamp()`); events reference messages by id and store `body_sha256`, never text; triggers forbid UPDATE/DELETE/TRUNCATE; hash chain with `verify_ticket_chain()`.

**Race design (INC-0291):** lock row (`FOR UPDATE`) + guarded `UPDATE ... WHERE assignee_id IS NULL`; loser gets 409 `already_claimed`; reply and resolve require ownership on the server.

**API surface:** see `docs/COPILOT_03...md` section 4 (auth, agent, customer endpoints, error codes).

---

## 6. Decision log (everything decided so far)

These are the interpretations the brief left open. Copilot appends them to `docs/DECISIONS.md` in the user's repo; the README should present them.

**Engine (doc 02):** (1) fixed-offset Asia/Kolkata only, DST zones intentionally unsupported; (2) day is half-open `[09:30,18:30)`, no lunch break; (3) a due date landing exactly on 18:30 stays that day; (4) "half a day"=270, "a day"=540, "about 3 days"=1620, "about a week"=2700 (all editable in tables); (5) High "same working day" = due at close of the day the clock started; (6) **priority change keeps the original clock start**, escalation can make a ticket instantly late, downgrade never erases a recorded breach (Meera's unanswered question); (7) pauses extend only the resolve deadline; (8) clock start floored to the whole minute; (9) auto-close and reopen windows are 2700 business minutes counted from when waiting began / the ticket was resolved.

**Lifecycle (doc 03):** (1) customer picks severity; (2) only owner can reply/resolve, any staff can add a note; (3) lead can release/reassign/change priority; (4) only a public reply counts as first response; (5) waiting only via a public reply with `setWaiting`; (6) resolving while waiting closes the pause and judges lateness at pause start; (7) customer message on a resolved ticket inside the window reopens it (new SLA cycle, same owner), reopen needs a message; (8) customer message on closed/past-window ticket makes a new linked ticket (`parent_ticket_id`, subject `Re: ...`, own token), including auto-closed ones; (9) DB clock is the time authority, tests inject a fake clock; (10) breaches also recorded at write time; (11) agent list never selects message text; (12) customer reads via views only, optionally a view-only DB role; (13) signed HttpOnly SameSite=Lax session cookie (12 h), user re-read from DB every request, `Origin` check against CSRF; (14) same 404 for unknown/malformed tokens, same 401 for unknown email/wrong password; (15) not built: login rate limiting, email verification/delivery, token rotation, list pagination, idle-lease auto-release, live presence.

**Background job and exports (doc 04):** (1) the tick runs immediately and then every 60 seconds by default, with same-process overlap prevention and `SKIP LOCKED` across processes; (2) deadlines are due at equality; (3) waiting tickets auto-close at `auto_close_at`, and resolved tickets close at `reopen_until`; (4) customer exports use only customer-view response fields and public messages; (5) agent exports omit notes unless explicitly included; (6) JSON and CSV only, per ticket, no PDF or bulk export; (7) CSV fields are quoted/escaped and formula-leading values are neutralized; (8) exports write an audit event with no message text.

**DB (doc 01):** messages are rows (not JSON blobs); `ticket_events` is append-only and hash-chained; events carry `message_id` + `body_sha256`, never the body; tickets are never deleted; `0002_roles_optional.sql` skips itself with a NOTICE on hosts that forbid role creation; holiday seed has only fixed-date national holidays (**floating festivals must be added from an official Kerala list**: not verified).

**Cut from scope on purpose:** read receipts (no customer channel in the brief), PDF export, "reply or reminder note required" rule (not in the brief), live agent presence.

---

## 7. Remaining work

Steps 04 and 05, including the approved customer-auth/UI improvements, are implemented and verified in the active app. The next planned step is deployment preparation, a project README, and the required honest "what did not finish" note. No deployment has been run.

### Doc 06: Deploy, README, closing note
- Hosting: the brief demands the app stay up **one week**. **Verify current free-tier limits first** (Render web + Postgres, Neon, Supabase, Railway, Fly): free Postgres tiers may expire or pause; I did not verify any of this. Build `npm install && npm run build`, start `npm start`, health `/api/health`, env `DATABASE_URL DATABASE_SSL SESSION_SECRET NODE_ENV=production SEED_PASSWORD (CUSTOMER_DATABASE_URL optional)`. Run `npm run db:seed` once. Hosts skip devDependencies at build: client build uses `--include=dev` (already in `package.json`).
- **Seed data:** keep the demo customer local/test only. If staff accounts are seeded in production, use a unique strong `SEED_PASSWORD`; create reviewer demo tickets only in a deliberately isolated demo environment.
- **README:** how to run locally, architecture, the decision log (section 6), the privacy/audit/race explanations with the test names that prove them, how to run tests, API summary.
- **Closing note ("what did you not finish, and why?")**: be specific and honest. Candidates from the known-gaps list: login rate limiting, email verification and delivery, token rotation, list pagination, idle-lease auto-release / live presence, PDF export, read receipts, floating festival holidays if not added, `0002` roles if the host refused them, anything Copilot did not complete.
- Reviewers will probably probe: business-time maths (Friday 6 PM, holidays, pause across weekend), the unanswered priority-change question, the claim race, the note leak, the audit immutability. All have tests.

---

## 8. Working method (follow this; it is why the documents can be trusted)

1. **Design, then build and test in the sandbox first.** Write code in a scratch project, run the real tests against a real Postgres 16.
2. **Write the tests first** and keep them **LOCKED** in the document (Copilot must never edit a test to make it pass).
3. **Mutation-test** the implementation (deliberately break it ~10 ways; each break must make a test fail). Missing coverage found this way: priority change counted from arrival instead of clock start; first-response overwritten by later replies; a hang when the calendar loop had no cap; both were fixed by adding tests or guards.
4. **Generate the document from the verified files** (`tools/build_doc03.py` and `tools/build_doc04.py`; docs 01 and 02 were written directly and verified by extracting their blocks into a clean project). Blocks are marked ```` ```js file=<path> ```` (create verbatim) and ```` ```js ref=<path> ```` (reference solution, "use only if stuck").
5. **Re-extract the finished document into a clean project and re-run the whole suite** (plus a different `TZ`). A document is "done" only after that passes.
6. **Be honest about what was not tested** at the end of every reply (see section 10).
7. Document structure used for every Copilot document: where it fits in the series; why; precise semantics; decisions to log; files and API; numbered steps each with a **Verify** block; acceptance checklist; troubleshooting table; out-of-scope; appendix reference implementation.

---

## 9. Sandbox environment notes (only if the next agent has a fresh sandbox)

- Postgres is not preinstalled. One-time: `apt-get update && apt-get install -y postgresql`. Then as the `postgres` user: `initdb -D /tmp/pg/data`, start with `pg_ctl -D /tmp/pg/data -o '-p 5433 -k /tmp/pg' -l /tmp/pg/log start`. `tools/start_test_postgres.sh` restarts it. **The server stops between tool calls**, so run that script before any test command.
- Local DB URL used for verification: `DATABASE_URL=postgres://postgres@localhost:5433/frontdesk` (trust auth). Copy `project/.env.example` to `.env` and change the URL/port.
- `npm install` in `project/`, then `npm test`. Expect **109 pass**.
- The shell is plain `sh`: use `bash -c` for brace expansion. **Never `pkill -f "node "`** (it killed the tool shell once). Kill by PID.
- Gotchas already solved (also in the documents' troubleshooting tables): `node --test tests/` fails on Node 22 (use plain `node --test`); Express 5 wildcard is `/{*splat}`; Drizzle wraps pg errors (real error in `err.cause`); never `drizzle-kit push`; `req.body` is undefined in Express 5 without a body; do not issue a query from a pg `connect` event (deprecation warning); use startup `options: '-c role=...'` for role-restricted pools; Tailwind v4 needs no config file; hosts skip devDependencies at build.

---

## 10. Honest limits of what was verified

- **Verified here:** Steps 01–03 reference code and tests; Step 04 active app; 128 active tests in the default and `America/Los_Angeles` timezones; customer-auth migrations and restricted-view tests; production client build; customer and agent browser flows; and `docs/smoke.sh` against a disposable database. Earlier Step 04 reference mutation checks also caught ten targeted regressions.
- **Not verified:** Copilot's own output; `docker-compose.yml` (no Docker in the environment); Vite development-server/proxy behavior; browser flows beyond the checked customer and agent paths; any hosting platform or free-tier limit; the Kerala festival holiday dates; or deployment.
- **Known gaps** (list in the user's closing note): see doc 03 decision 15 and section 7 above.

---

## 11. Open questions for the user (ask in your first reply)

1. Which of steps 02 and 03 has Copilot finished? Any failing tests or surprises?
2. Which host will they use (and have they checked the free-tier limits for a one-week uptime)?
3. Do they want demo seed data in the deployed app?
4. Have they added the Kerala festival holidays to the `holidays` table?
5. How much of the 8-hour budget is left, so doc 05 (UI) can be sized to fit?

---

## 12. Bundle contents

```
HANDOFF.md            this file
CHAT_HISTORY.md       condensed record of the whole conversation, with the user's messages
MANIFEST.txt          sha256 of every file
docs/
  00_ORIGINAL_BRIEF_Hiring_Test.pdf
  DB_Implement.MD                                    database design (Drizzle version)
  COPILOT_01_SETUP_AND_MIGRATIONS.md                 doc 01 for Copilot
  COPILOT_02_BUSINESS_TIME_AND_SLA_ENGINE.md         doc 02
  COPILOT_03_AUTH_AND_TICKET_LIFECYCLE.md            doc 03 (large: contains all tests and a reference implementation)
  COPILOT_04_BACKGROUND_JOB_AND_EXPORTS.md           doc 04 (locked tests and reference implementation)
  PLAN_05_AGENT_UI_AND_CUSTOMER_PAGE.md              approved plan and implementation record for step 05
  frontdesk-db_step01_original.zip                   the Drizzle schema + migrations (LOCKED files used in step 01)
project/              verified reference project (123 passing tests). Not the user's repo
tools/                start_test_postgres.sh, build_doc03.py/doc03.tpl, build_doc04.py/doc04.tpl, README.md
```
