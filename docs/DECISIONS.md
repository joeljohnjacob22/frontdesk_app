# Decisions log

| Date | Decision | Reason |
|---|---|---|
| 2026-11-21 | Use `bcryptjs` for password hashing. | Pure JavaScript avoids native build requirements on deployment hosts. |
| 2026-11-21 | Run tests with plain `node --test`, without a directory argument. | Node 22 does not support a directory argument such as `tests/`. |
| 2026-11-21 | Run database migrations as part of `npm start`. | Each deployment brings the database schema up to date before starting the server. |
| 2026-11-21 | Seed 1 lead and 9 agents with the shared demo password from `SEED_PASSWORD`, documented in the README. | Arvo has nine agents (brief section 2). |

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
