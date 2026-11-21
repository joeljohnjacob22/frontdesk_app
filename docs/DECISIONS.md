# Decisions log

| Date | Decision | Reason |
|---|---|---|
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

## Hosting readiness

| Item | Value |
|---|---|
| Build command | `npm install && npm run build` |
| Start command | `npm start` (migrates, then serves) |
| Health check path | `/api/health` |
| Environment variables | `DATABASE_URL`, `DATABASE_SSL=true` if required by the host, a long random `SESSION_SECRET`, `NODE_ENV=production`, `SEED_PASSWORD` |
| Build gotcha | Hosts may set `NODE_ENV=production` during build and skip devDependencies. The `build` script uses `--include=dev` for the client so Vite is installed. |
| One-time setup | Run `npm run db:seed` once against the hosted database, locally or from the host shell. |
| Host selection check | Free Postgres tiers can expire or pause. Confirm current free-tier limits; the app must remain available for the one-week test. |
