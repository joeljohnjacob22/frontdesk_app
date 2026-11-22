# Decisions log

| Date | Decision | Reason |
|---|---|---|
| 2026-11-22 | Customers choose severity when raising a ticket; medium is the default, and agents can change it. | Meera's tiers are defined by customer impact. Nobody else knows it at the start. |
| 2026-11-22 | Only the owner can send a public reply or resolve; any signed-in staff member can add a team note. | INC-0291 (two conflicting answers). Notes are internal, so any teammate may help. |
| 2026-11-22 | A lead can release, reassign, or change the priority of any ticket; the owner can release and change priority on their own. | Leads need a way out when an owner is away. |
| 2026-11-22 | Only a public reply counts as the first response; a note never stops the reply clock. | A note is invisible to the customer. |
| 2026-11-22 | A ticket becomes `waiting_on_customer` only through a public reply with `setWaiting: true`, which opens an SLA pause. | The pause rule is "we asked the customer a question". |
| 2026-11-22 | Resolving while waiting closes the pause, and waiting time is not held against Arvo; the deadline is judged when the wait began. | Meera: "that week is not our fault". |
| 2026-11-22 | A customer message on a resolved ticket inside the reopen window reopens it in a new SLA cycle with the same owner. | One endpoint, and Arvo learns what is still wrong. |
| 2026-11-22 | A customer message on a closed ticket, or a resolved ticket past the window, creates a linked ticket with its own link; auto-closed tickets behave the same way. | Meera: "after that it is a new ticket", "they can always contact us again". |
| 2026-11-22 | The database clock is the time authority; timestamps come from `clock_timestamp()` in the transaction, and tests inject a fake clock. | INC-0318: one source of truth for "when". |
| 2026-11-22 | Breaches are recorded at write time as well as by the background job. | The job runs once a minute. A late reply must never go unrecorded if it has not run. |
| 2026-11-22 | The agent ticket list never selects message text. | INC-0304: "Not in a list". No previews, no snippets. |
| 2026-11-22 | Customer reads use `customer_*` views only, optionally through a view-only DB role (`CUSTOMER_DATABASE_URL`). | Defence in depth for INC-0304. |
| 2026-11-22 | Sessions use a signed, HttpOnly, SameSite=Lax cookie for 12 hours, rechecked against the database on every request; cross-site writes are blocked by an Origin check. | No dependency. Deactivating a user takes effect immediately. |
| 2026-11-22 | Unknown and malformed tokens both return `404 ticket_not_found`; login uses the same "Wrong email or password" message for unknown email and wrong password. | Do not reveal what exists. |
| 2026-11-22 | Not built: login rate limiting, email verification or delivery, token rotation, list pagination, idle-lease auto-release, and live presence. | Out of an 8-hour scope. |
| 2026-11-21 | Use `bcryptjs` for password hashing. | Pure JavaScript avoids native build requirements on deployment hosts. |
| 2026-11-21 | Run tests with plain `node --test`, without a directory argument. | Node 22 does not support a directory argument such as `tests/`. |
| 2026-11-21 | Run database migrations as part of `npm start`. | Each deployment brings the database schema up to date before starting the server. |
| 2026-11-21 | Seed 1 lead and 9 agents with the shared demo password from `SEED_PASSWORD`, documented in the README. | Arvo has nine agents (brief section 2). |
| 2026-11-21 | Time zone is fixed-offset Asia/Kolkata (+05:30); supported zones are listed in `ZONE_OFFSETS`, and daylight-saving zones are unsupported. | Kolkata has no DST, so integer arithmetic is exact and needs no date library. |
| 2026-11-21 | Working time is the half-open interval [09:30, 18:30), with no lunch break. | The brief specifies working hours from 9:30 to 6:30 only. |
| 2026-11-21 | A deadline landing exactly at 18:30 stays on that day. | A deadline at close of business is not met or missed until after 18:30. |
| 2026-11-21 | SLA durations are 270 minutes for half a day, 540 for one day, 1620 for three days, and 2700 for five working days. | The brief uses approximate durations; values remain adjustable in the `sla_policies` and `settings` tables. |
| 2026-11-21 | High-priority resolution is due at the close of the day its clock starts. | This is the literal interpretation of the brief's "fix the same working day" requirement. |
| 2026-11-21 | Priority changes keep the original clock start; new budgets apply to total elapsed time, and downgrading does not erase a recorded breach. | Resetting the clock would let an agent hide lateness by changing priority. |
| 2026-11-21 | Pauses extend only the resolution deadline, never the reply deadline. | A ticket can only wait on the customer after an agent has replied. |
| 2026-11-21 | The SLA clock start is floored to a whole minute. | Budgets use whole minutes; flooring lets a ticket arriving at 18:29:30 receive a one-minute same-day budget. |
| 2026-11-21 | Auto-close and reopen windows are 2700 business minutes from when waiting begins or the ticket is resolved. | The brief specifies about one working week. |
| 2026-11-22 | The background tick runs immediately and then every `TICK_INTERVAL_MS` (60 seconds by default); overlapping runs are skipped in one process, and row locks coordinate multiple processes. | Breaches and due transitions must progress without waiting for another ticket request. |
| 2026-11-22 | Tick deadlines are due at equality (`deadline <= now`). | A ticket should transition as soon as its configured deadline is reached. |
| 2026-11-22 | A waiting ticket auto-closes when `auto_close_at` is reached, and a resolved ticket closes when `reopen_until` is reached. | The brief's "about one working week" rules need a consistent, testable boundary. |
| 2026-11-22 | Customer exports contain only explicitly selected customer-view fields and public messages; agent exports omit team notes unless explicitly requested. | INC-0304 applies to exports as well as screens and API responses. |
| 2026-11-22 | Exports are per-ticket JSON or CSV; PDF and bulk export are not included. | Keep the take-home scope small and avoid adding a document-generation dependency. |
| 2026-11-22 | CSV formula-leading cells, including those preceded by leading ASCII whitespace, are apostrophe-prefixed; every field is quoted and embedded quotes are doubled. | Prevent spreadsheet formula interpretation and malformed CSV fields. |
| 2026-11-22 | Each successful export writes an `export_generated` event containing only its format and note-inclusion flag. | Preserve an audit record without copying message content into the event chain. |
| 2026-11-22 | `npm test` names the active `tests/*.test.js` files explicitly rather than using recursive default discovery. | The handoff's bundled reference project contains its own tests; recursive discovery would run every active test twice. Explicit file paths remain supported without passing an unsupported directory argument. |
| 2026-11-22 | The development proxy forwards the browser's original `Host` header with `changeOrigin: false`. | The server compares `Origin` and `Host` on writes; forwarding the browser host keeps the dev proxy same-origin without weakening that check. |
| 2026-11-22 | The seeded demo customer is created outside production only; self-registration remains available in production. | A shared demo password is for local testing, not a production customer identity. |
| 2026-11-22 | Customer lists sort by latest public-message activity; “New reply” stays visible while staff authored the latest public message and clears when the customer replies. Agent lists retain late/due-date ordering. | The customer asked for activity ordering and an indicator that does not require separate read tracking, while agent queues must continue to surface SLA risk first. |
| 2026-11-22 | Leads create agents with a generated temporary password that is shown once; the new agent must change it at first sign-in. | No email delivery is configured, so the lead can securely share an initial password without permitting public staff registration. |
| 2026-11-22 | Production seeding refuses the local default password `frontdesk-demo`. | The seeded lead and agents are privileged accounts, so deployment must supply an explicit non-default `SEED_PASSWORD`. |

## Hosting readiness

| Item | Value |
|---|---|
| Build command | `npm install && npm run build` |
| Start command | `npm start` (migrates, then serves) |
| Health check path | `/api/health` |
| Environment variables | `DATABASE_URL`, `DATABASE_SSL=true` if required by the host, a long random `SESSION_SECRET`, `NODE_ENV=production`, `SEED_PASSWORD` |
| Build gotcha | Hosts may set `NODE_ENV=production` during build and skip devDependencies. The `build` script uses `--include=dev` for the client so Vite is installed. |
| One-time setup | Set a unique `SEED_PASSWORD`, then run `npm run db:seed` once against the hosted database, locally or from the host shell. Production seeding refuses `frontdesk-demo`. |
| Host selection check | Free Postgres tiers can expire or pause. Confirm current free-tier limits; the app must remain available for the one-week test. |
