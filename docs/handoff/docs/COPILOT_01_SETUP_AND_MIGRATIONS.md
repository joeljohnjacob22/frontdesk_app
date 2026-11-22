# COPILOT 01: Project Setup and Database Migrations

**Project:** Frontdesk, a support-ticket system for Arvo Systems (hiring test).
**This document:** step 1 of a series. It takes an empty folder to a running, tested skeleton: database migrated and seeded, Express API answering `/api/health`, React + Tailwind client building, tests green.

| # | Document | Delivers |
|---|---|---|
| **01** | **Setup and migrations (this file)** | Repo, DB, migrations, seed, server skeleton, client skeleton, test harness |
| 02 | Business-time and SLA engine | Pure time module, holidays, due-date maths, unit tests |
| 03 | Ticket lifecycle API | Auth, claim, reply, note, statuses, tick job, audit events, privacy tests |
| 04 | Agent UI and customer view | React screens, exports |
| 05 | Deploy and README | Hosting, README, "what I did not finish" note |

---

## 0. How to use this document with Copilot

1. Put these in the repo before you start: this file at `docs/COPILOT_01_SETUP_AND_MIGRATIONS.md`, and `DB_Implement.MD` at `docs/DB_Implement.MD`. Copilot can then read them as context.
2. Create `.github/copilot-instructions.md` and paste in **section 1** (the project rules). Copilot applies it to every later step.
3. Use **Copilot Chat in Agent mode** (it can run terminal commands). Work **one step at a time**. Paste:

   > Read `docs/COPILOT_01_SETUP_AND_MIGRATIONS.md`. Do **Step N only**. Create exactly the files it specifies, with exactly the content given where content is given. Run the Verify commands and show me the output. Do not start Step N+1.

4. **Commit after every step** that passes its Verify block (`git commit -m "step N: ..."`). If Copilot drifts, `git restore .` is your undo button.
5. Code blocks marked `file=path` are meant to be **created verbatim**. Where this document says **LOCKED**, Copilot must copy the file unchanged and must not "improve" it.

---

## 1. Project rules (paste into `.github/copilot-instructions.md`)

```markdown file=.github/copilot-instructions.md
# Frontdesk: rules for every change

## Stack (do not substitute)
- Node.js >= 20.19, **JavaScript ES modules only**. No TypeScript, no CommonJS (`require`).
- Express 5, PostgreSQL, **Drizzle ORM** with the `pg` driver.
- React 19 + Vite + Tailwind CSS v4 + React Router. Tests use `node:test` and `node:assert/strict`.
- Business timezone is Asia/Kolkata. Everything is stored and transmitted in UTC.

## Database
- `db/schema.js` and `db/migrations/**` are **LOCKED**. Never edit a migration that has been applied.
  To change the schema: edit `db/schema.js`, run `npm run db:generate`, commit the new SQL file.
  For triggers/functions/views use `npx drizzle-kit generate --custom --name=<name>`.
- **Never run `drizzle-kit push`.** Only `generate` + `migrate`.
- Drizzle wraps Postgres errors. The real error is `err.cause` (`err.cause.code`, `err.cause.message`).

## Rules that come from the incident reports
- **Timestamps:** the server/database sets every timestamp. Never accept a timestamp from a client.
  API output is ISO-8601 UTC with a `Z`. Convert to Asia/Kolkata only in the UI.
- **Private notes (INC-0304):** a note (`messages.kind = 'note'`) must never reach a customer: not in a
  response, list, preview, count, search, export or audit view. Customer code reads messages ONLY from
  the `customer_messages` view. List queries never select message bodies.
- **Audit (INC-0318):** `messages` and `ticket_events` are append-only. Never UPDATE or DELETE them.
  Write events in the same transaction as the change they record. Events reference messages by id
  and store `body_sha256`, never the body.
- **Concurrency (INC-0291):** state changes are ONE atomic statement guarded by a WHERE clause
  (`UPDATE ... WHERE assignee_id IS NULL ... RETURNING`). Zero rows returned means respond 409.
  Multi-step changes use `db.transaction` and lock the row with `.for('update')`.
- Authorization is enforced on the server. A hidden button is not security.

## Code style
- Small named-export modules. `async/await`. No premature abstraction. Comments explain WHY.
- API errors are JSON: `{ "error": { "code": "snake_case", "message": "human text" } }`.
- Never leak SQL or stack traces in a response. Log them server-side.
- No new dependency unless a step asks for it.

## Process
- `npm test` must pass before a commit. Every rule above that you touch gets a test.
- Tests use a throwaway database (`tests/helpers/testDb.js`). Never run tests against a real database.
- Whenever you interpret something the brief left open, append one line to `docs/DECISIONS.md`
  (date, decision, reason). Do not silently guess.
- Do only what the current step asks. If something is unclear, ask instead of inventing.
- Never commit `.env` or secrets.
```

---

## 2. Goal and definition of done

After Step 10, from a fresh clone these commands work:

```bash
cp .env.example .env
docker compose up -d db          # or any local Postgres 14+
npm install && npm run db:migrate && npm run db:seed
npm test                         # all green
npm run dev                      # API on :3000, client on :5173
curl localhost:3000/api/health   # {"ok":true,"db":"up",...}
```

and the database contains: 10 tables, 3 views, the append-only and hash-chain triggers, 3 SLA policies, 6 settings, 4 holidays, 1 lead and 9 agents.

## 3. Prerequisites

| Need | Check |
|---|---|
| Node.js 20.19+ (or 22.12+) | `node -v` |
| Git | `git --version` |
| PostgreSQL 14+ (Docker is easiest) | `docker --version`, or a local `psql` |
| The file `frontdesk-db.zip` (or `DB_Implement.MD` sections 5.3 to 5.5) | the **LOCKED** source for Step 3 |

## 4. Target layout

```
frontdesk/
├─ .github/copilot-instructions.md
├─ .env.example   .gitignore   docker-compose.yml
├─ package.json   drizzle.config.js
├─ docs/            DB_Implement.MD  COPILOT_01_...md  DECISIONS.md
├─ db/
│  ├─ schema.js            LOCKED (from zip)
│  ├─ migrations/          LOCKED (from zip): 0000, 0001, 0002 + meta/
│  ├─ client.js  migrate.js  seed.js  reset.js
├─ server/
│  ├─ config.js  app.js  index.js
├─ tests/
│  ├─ helpers/ testDb.js  assertions.js
│  └─ db.test.js  schema.test.js  health.test.js
└─ client/  (Vite + React + Tailwind v4)
```

All npm scripts run from the repo root.

---

## 5. Steps

### Step 1: Repository, dependencies and config files

**Create the repo and install:**

```bash
mkdir frontdesk && cd frontdesk && git init
mkdir -p docs db server tests/helpers .github
# then create the files below
npm install
```

```json file=package.json
{
  "name": "frontdesk",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.19" },
  "scripts": {
    "dev": "concurrently -n api,web -c blue,green \"npm:dev:server\" \"npm:dev:client\"",
    "dev:server": "node --watch server/index.js",
    "dev:client": "npm --prefix client run dev",
    "build": "npm --prefix client install --include=dev && npm --prefix client run build",
    "start": "node db/migrate.js && node server/index.js",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "node db/migrate.js",
    "db:seed": "node db/seed.js",
    "db:reset": "node db/reset.js",
    "test": "node --test"
  },
  "dependencies": {
    "bcryptjs": "^3.0.3",
    "dotenv": "^18.0.10",
    "drizzle-orm": "^0.45.4",
    "express": "^5.3.0",
    "pg": "^8.23.1"
  },
  "devDependencies": {
    "concurrently": "^10.0.7",
    "drizzle-kit": "^0.31.11"
  }
}
```

Why these choices (add to `docs/DECISIONS.md`): `bcryptjs` is pure JavaScript, so it deploys on any host with no native build. `npm test` is plain `node --test` with no path, because on Node 22 `node --test tests/` fails (a directory argument is not supported). `start` runs migrations before the server, so every deploy brings the database up to date.

```gitignore file=.gitignore
node_modules/
.env
client/dist/
client/node_modules/
*.log
.DS_Store
```

```bash file=.env.example
# Postgres connection used by the app, migrations and seed
DATABASE_URL=postgres://postgres:postgres@localhost:5432/frontdesk
# true for hosted databases that require SSL (e.g. Render external URL, Neon)
DATABASE_SSL=false

# Tests create throwaway databases on this server. Defaults to DATABASE_URL's server.
# Tests REFUSE non-local hosts unless ALLOW_REMOTE_TEST_DB=true.
TEST_DATABASE_URL=

PORT=3000
NODE_ENV=development
# Required when NODE_ENV=production (used by auth in a later step)
SESSION_SECRET=change-me-dev-only

# Password given to the seeded demo users
SEED_PASSWORD=frontdesk-demo

# Optional: a login that only has the customer_reader role (see db/migrations/0002). Used in a later step.
CUSTOMER_DATABASE_URL=
# Background job interval (used in a later step)
TICK_INTERVAL_MS=60000
```

```yaml file=docker-compose.yml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: frontdesk
    ports:
      - "5432:5432"
    volumes:
      - frontdesk_pgdata:/var/lib/postgresql/data
volumes:
  frontdesk_pgdata:
```

Also create an empty `docs/DECISIONS.md` containing a heading `# Decisions log` and the table header `| Date | Decision | Reason |`.

**Verify**

```bash
cp .env.example .env
docker compose up -d db          # skip if you have local Postgres; then edit DATABASE_URL in .env
node -v && npm ls --depth=0      # no errors, all packages listed
```

---

### Step 2: Config module

```js file=server/config.js
import 'dotenv/config';

// Fail fast: a missing setting should stop the process at boot, not at the first request.
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const env = process.env.NODE_ENV ?? 'development';
const isProd = env === 'production';

export const config = Object.freeze({
  env,
  isProd,
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  customerDatabaseUrl: process.env.CUSTOMER_DATABASE_URL || null,
  sessionSecret: isProd ? required('SESSION_SECRET') : (process.env.SESSION_SECRET ?? 'dev-only-secret'),
  seedPassword: process.env.SEED_PASSWORD ?? 'frontdesk-demo',
  tickIntervalMs: Number(process.env.TICK_INTERVAL_MS ?? 60000),
});
```

**Verify:** `node -e "import('./server/config.js').then(m => console.log(m.config.port))"` prints `3000`. Running it with `DATABASE_URL=` (empty) throws `Missing required environment variable DATABASE_URL`.

---

### Step 3: Database layer (LOCKED files + connection code + migrate)

#### 3a. Copy the LOCKED files

Extract `frontdesk-db.zip` somewhere temporary and copy **only** these into the repo, byte for byte:

```
db/schema.js
db/migrations/0000_schema.sql
db/migrations/0001_db_logic.sql
db/migrations/0002_roles_optional.sql
db/migrations/meta/        (the whole folder: _journal.json and the three *_snapshot.json files)
```

> **Do not** copy the zip's own `package.json`, `migrate.js`, `drizzle.config.js` or `tests/`. This document replaces them.
> **Do not** run `drizzle-kit generate` now. The migrations already exist. Re-generating would create a duplicate.
> If you have no zip, copy the `schema.js` block from `DB_Implement.MD` section 5.3, the SQL from 5.4 into `0001_db_logic.sql` and from 5.5 into `0002_roles_optional.sql`, and run `npx drizzle-kit generate --name=schema` first, then the two `--custom` generates, **in that order**, so the numbering matches.

What each migration does:

| File | Contents |
|---|---|
| `0000_schema.sql` | Generated by Drizzle: enums, 10 tables, foreign keys, CHECK constraints, partial and expression indexes |
| `0001_db_logic.sql` | Hand-written: `pgcrypto`, `set_updated_at`, `forbid_modification`, append-only triggers, hash-chain trigger + `verify_ticket_chain()`, the 3 views, seed data (policies, settings, holidays) |
| `0002_roles_optional.sql` | Hand-written, optional: DB roles. It **skips itself** with a NOTICE if the migration user lacks permission, so it can never fail a deploy |

#### 3b. `drizzle.config.js`

```js file=drizzle.config.js
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.js',
  out: './db/migrations',
  dbCredentials: { url: process.env.DATABASE_URL },
});
```

#### 3c. Connection helpers (no side effects at import)

```js file=db/client.js
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { config } from '../server/config.js';

// All ids are bigint. pg returns int8 as a string by default; ids and counts here are far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));

export function createPool(connectionString = config.databaseUrl, options = {}) {
  const pool = new pg.Pool({
    connectionString,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
    ...options,
  });
  // No session time zone is set on purpose: every time column is timestamptz (an absolute instant) and
  // the audit hash uses epoch seconds, so nothing depends on it. (A SET issued from the 'connect'
  // event also triggers a pg deprecation warning, and some connection poolers reject startup options.)
  pool.on('error', (err) => console.error('Unexpected pg pool error:', err));
  return pool;
}

export function createDb(pool) {
  return drizzle(pool, { schema });
}
```

#### 3d. Migration runner

```js file=db/migrate.js
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPool } from './client.js';

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(pool) {
  await migrate(drizzle(pool), { migrationsFolder });
}

// Run as a script: `node db/migrate.js`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  try {
    await runMigrations(pool);
    console.log('migrated');
  } catch (err) {
    console.error('Migration failed:', err.cause?.message ?? err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
```

#### 3e. Dev-only reset

```js file=db/reset.js
import { pathToFileURL } from 'node:url';
import { config } from '../server/config.js';
import { createPool } from './client.js';
import { runMigrations } from './migrate.js';

// Wipes the public and drizzle schemas, then re-applies every migration. DEVELOPMENT ONLY.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = new URL(config.databaseUrl).hostname;
  if (config.isProd || !['localhost', '127.0.0.1', '::1', 'db'].includes(host)) {
    console.error(`Refusing to reset a non-local or production database (${host}).`);
    process.exit(1);
  }
  const pool = createPool();
  try {
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await runMigrations(pool);
    console.log('database reset and migrated');
  } finally {
    await pool.end();
  }
}
```

**Verify**

```bash
npm run db:migrate           # prints: migrated
npm run db:migrate           # run twice: still prints "migrated" and changes nothing
psql "$DATABASE_URL" -c "\dt"   # 10 tables + drizzle's own bookkeeping lives in schema "drizzle"
psql "$DATABASE_URL" -c "\dv"   # agent_ticket_list, customer_messages, customer_tickets
psql "$DATABASE_URL" -c "SELECT priority, reply_minutes, resolve_minutes, resolve_same_day FROM sla_policies ORDER BY 1"
```

Expected policies: `high 120 NULL t`, `low 540 2700 f`, `medium 270 1620 f`.

---

### Step 4: Seed users

```js file=db/seed.js
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { config } from '../server/config.js';
import { createPool, createDb } from './client.js';
import { users } from './schema.js';

export const SEED_USERS = [
  { name: 'Meera Nair',    email: 'meera@arvo.test',  role: 'lead' },
  { name: 'Anil Kumar',    email: 'anil@arvo.test',   role: 'agent' },
  { name: 'Priya Menon',   email: 'priya@arvo.test',  role: 'agent' },
  { name: 'Rahul Varma',   email: 'rahul@arvo.test',  role: 'agent' },
  { name: 'Sneha Pillai',  email: 'sneha@arvo.test',  role: 'agent' },
  { name: 'Arjun Das',     email: 'arjun@arvo.test',  role: 'agent' },
  { name: 'Divya Thomas',  email: 'divya@arvo.test',  role: 'agent' },
  { name: 'Faisal Rahman', email: 'faisal@arvo.test', role: 'agent' },
  { name: 'Lakshmi Iyer',  email: 'lakshmi@arvo.test', role: 'agent' },
  { name: 'Joseph Mathew', email: 'joseph@arvo.test', role: 'agent' },
];

// Idempotent: existing emails are left untouched, so it is safe to run on every deploy.
export async function seedUsers(db, password = config.seedPassword) {
  const passwordHash = await bcrypt.hash(password, 10);
  const rows = SEED_USERS.map((u) => ({ ...u, passwordHash }));
  const inserted = await db.insert(users).values(rows).onConflictDoNothing().returning({ id: users.id });
  return inserted.length;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  try {
    const n = await seedUsers(createDb(pool));
    console.log(`seeded ${n} new user(s) (${SEED_USERS.length} total defined)`);
  } finally {
    await pool.end();
  }
}
```

Add to `docs/DECISIONS.md`: "Seed: 1 lead + 9 agents, shared demo password from `SEED_PASSWORD`, documented in the README. Reason: Arvo has nine agents (brief §2)."

**Verify**

```bash
npm run db:seed    # first run:  seeded 10 new user(s) (10 total defined)
npm run db:seed    # second run: seeded 0 new user(s) (10 total defined)
psql "$DATABASE_URL" -c "SELECT role, count(*) FROM users GROUP BY 1"   # agent 9, lead 1
```

---

### Step 5: Express skeleton

```js file=server/app.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { sql } from 'drizzle-orm';

const here = path.dirname(fileURLToPath(import.meta.url));

// A factory (not a singleton) so tests can build an app around a throwaway database.
export function createApp({ db, clientDir = path.resolve(here, '../client/dist') } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ ok: true, db: 'up', time: new Date().toISOString() });
    } catch (err) {
      console.error('health check failed:', err.cause?.message ?? err.message);
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // Later steps mount here:  /api/agent/*  (session auth)   /api/customer/*  (ticket token)

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such API route' } });
  });

  // Production: Express also serves the built React app (one deployable service).
  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    // Express 5 wildcard syntax. Plain '*' no longer works.
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  // Last: never leak SQL or stack traces to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err.cause?.message ?? err.stack ?? err);
    res.status(status).json({
      error: {
        code: err.code && typeof err.code === 'string' && status < 500 ? err.code : 'internal_error',
        message: status < 500 ? err.message : 'Something went wrong',
      },
    });
  });

  return app;
}
```

```js file=server/index.js
import { config } from './config.js';
import { createPool, createDb } from '../db/client.js';
import { createApp } from './app.js';

const pool = createPool();
const db = createDb(pool);
const app = createApp({ db });

const server = app.listen(config.port, () => {
  console.log(`Frontdesk API listening on :${config.port} (${config.env})`);
});

// Later step: start the SLA tick job here (every config.tickIntervalMs).

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => pool.end().then(() => process.exit(0)));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

**Verify**

```bash
npm run dev:server &            # or in a second terminal
curl -s localhost:3000/api/health          # {"ok":true,"db":"up","time":"...Z"}
curl -s -i localhost:3000/api/nope         # 404 with {"error":{"code":"not_found",...}}
```

---

### Step 6: Test harness and the first tests

Tests build a **throwaway database per test file**, so they never collide and never touch real data.

```js file=tests/helpers/testDb.js
import crypto from 'node:crypto';
import pg from 'pg';
import { createPool, createDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';

const SAFE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'db', 'postgres']);

function baseUrl() {
  const raw = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!raw) throw new Error('Set TEST_DATABASE_URL or DATABASE_URL');
  const url = new URL(raw);
  // Guard rail: a typo must never point the test suite at a real database.
  if (!SAFE_HOSTS.has(url.hostname) && process.env.ALLOW_REMOTE_TEST_DB !== 'true') {
    throw new Error(`Refusing to run tests against non-local host "${url.hostname}"`);
  }
  return url;
}

// Creates "frontdesk_test_<random>", runs every migration, returns handles and a drop() cleanup.
export async function createTestDb() {
  const base = baseUrl();
  const name = `frontdesk_test_${crypto.randomBytes(4).toString('hex')}`;
  const adminUrl = new URL(base); adminUrl.pathname = '/postgres';
  const testUrl = new URL(base); testUrl.pathname = `/${name}`;

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const pool = createPool(testUrl.toString(), { max: 10 });
  await runMigrations(pool);
  const db = createDb(pool);

  async function drop() {
    await pool.end();
    const a = new pg.Client({ connectionString: adminUrl.toString() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await a.end();
  }
  return { db, pool, url: testUrl.toString(), drop };
}
```

```js file=tests/helpers/assertions.js
import assert from 'node:assert/strict';

// Drizzle wraps driver errors ("Failed query: ..."). The Postgres message/code is on err.cause.
export function rejectsPg(promise, pattern) {
  return assert.rejects(promise, (err) => pattern.test(err.cause?.message ?? err.message));
}
```

**Test 1: the database structure is complete** (this proves the migrations ran as designed):

```js file=tests/schema.test.js
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
```

**Test 2: behaviour rules from the incident reports** (claim race, note privacy, append-only, audit chain, status shape):

```js file=tests/db.test.js
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
```

**Test 3: the API skeleton**:

```js file=tests/health.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createTestDb } from './helpers/testDb.js';

const ctx = await createTestDb();
const app = createApp({ db: ctx.db, clientDir: '/nonexistent' });
const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await ctx.drop();
});

test('GET /api/health reports the database is up', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, 'up');
  assert.match(body.time, /Z$/);   // UTC, ISO-8601
});

test('unknown /api route returns the JSON error shape', async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: { code: 'not_found', message: 'No such API route' } });
});
```

**Verify**

```bash
npm test
```

Expected: `# pass 14`, `# fail 0`. If it fails, see section 7.

---

### Step 7: Client skeleton (Vite + React + Tailwind v4 + React Router)

```bash
mkdir -p client/src/pages
```

```json file=client/package.json
{
  "name": "frontdesk-client",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.3.1",
    "react-dom": "^19.3.1",
    "react-router-dom": "^7.18.6"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.5",
    "@vitejs/plugin-react": "^6.3.0",
    "tailwindcss": "^4.3.5",
    "vite": "^8.3.8"
  }
}
```

```js file=client/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In development the browser talks to Vite (5173); /api is forwarded to Express (3000).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: 'dist' },
});
```

```html file=client/index.html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Frontdesk</title>
  </head>
  <body class="bg-slate-50 text-slate-900">
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

```css file=client/src/index.css
@import "tailwindcss";
```

```jsx file=client/src/main.jsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

```js file=client/src/api.js
// One place for all HTTP calls. Same-origin cookies carry the agent session (added in a later step).
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? res.statusText);
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}
```

```jsx file=client/src/App.jsx
import { useEffect, useState } from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import { api } from './api.js';

function Page({ title, children }) {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="mt-4 text-slate-600">{children}</div>
    </main>
  );
}

function Home() {
  const [health, setHealth] = useState('checking...');
  useEffect(() => {
    api('/health').then((h) => setHealth(`API ${h.ok ? 'ok' : 'down'}, database ${h.db}`))
      .catch(() => setHealth('API unreachable'));
  }, []);
  return (
    <Page title="Frontdesk">
      <p className="rounded bg-white p-3 shadow-sm ring-1 ring-slate-200">{health}</p>
      <nav className="mt-4 flex gap-4 text-blue-700 underline">
        <Link to="/login">Agent login</Link>
        <Link to="/new">New ticket</Link>
      </nav>
    </Page>
  );
}

// Placeholders: later steps replace these.
const Login = () => <Page title="Agent login">Coming in step 04.</Page>;
const NewTicket = () => <Page title="Raise a ticket">Coming in step 04.</Page>;
const AgentTickets = () => <Page title="My tickets">Coming in step 04.</Page>;
const TicketDetail = () => <Page title="Ticket">Coming in step 04.</Page>;
const CustomerView = () => <Page title="Your ticket">Coming in step 04.</Page>;
const NotFound = () => <Page title="Not found">That page does not exist.</Page>;

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/new" element={<NewTicket />} />
      <Route path="/tickets" element={<AgentTickets />} />
      <Route path="/tickets/:id" element={<TicketDetail />} />
      <Route path="/t/:token" element={<CustomerView />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
```

> Tailwind v4 needs **no** `tailwind.config.js` and **no** PostCSS config. The Vite plugin plus `@import "tailwindcss"` is all it takes. If Copilot generates a v3-style config (`tailwind.config.js`, `postcss.config.js`, `@tailwind base;`), delete it.

**Verify**

```bash
npm run build                      # installs client deps and builds client/dist
ls client/dist                     # index.html and assets/
```

---

### Step 8: One-service production check

`server/app.js` already serves `client/dist` when it exists. Confirm it:

```bash
npm run build
NODE_ENV=production SESSION_SECRET=test npm start &
curl -s localhost:3000/api/health                 # JSON
curl -s localhost:3000/ | grep -o "<title>.*</title>"      # <title>Frontdesk</title>
curl -s localhost:3000/tickets/42 | grep -o "<title>.*</title>"   # same: the SPA fallback works
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/nope    # 404, not the HTML page
kill %1
```

`npm start` runs migrations first, then the server, which is exactly what the hosting platform will run.

---

### Step 9: Hosting readiness (no deploy yet)

Record these in `docs/DECISIONS.md` so Step 05 is quick:

| Item | Value |
|---|---|
| Build command | `npm install && npm run build` |
| Start command | `npm start` (migrates, then serves) |
| Health check path | `/api/health` |
| Env vars to set | `DATABASE_URL`, `DATABASE_SSL=true` (if the host needs it), `SESSION_SECRET` (long random), `NODE_ENV=production`, `SEED_PASSWORD` |
| Build gotcha | Hosts set `NODE_ENV=production` during build and skip devDependencies. The `build` script uses `--include=dev` for the client so Vite is installed. |
| One-time | Run `npm run db:seed` once against the hosted database (from your machine, or the host's shell) |
| Check before choosing a host | Free Postgres tiers can expire or pause. The test needs the app up for one week, so confirm the current free-tier limits first |

---

### Step 10: Final checks and commit

```bash
npm run db:reset && npm run db:seed    # proves a from-scratch setup works
npm test
git add -A && git commit -m "step 1: setup, migrations, seed, server+client skeleton, tests"
```

---

## 6. Acceptance checklist

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Migrations apply twice | `npm run db:migrate` ×2 | `migrated` both times |
| 2 | Structure | `\dt` / `\dv` | 10 tables, 3 views |
| 3 | Seed | `SELECT role, count(*) FROM users GROUP BY 1` | agent 9, lead 1 |
| 4 | SLA rules | `SELECT * FROM sla_policies` | high 120/same-day, medium 270/1620, low 540/2700 |
| 5 | History is locked | `UPDATE messages SET body='x';` (with a row present) | `ERROR: UPDATE on messages is not allowed: this table is append-only` |
| 6 | Tests | `npm test` | 14 pass, 0 fail |
| 7 | API | `curl localhost:3000/api/health` | `{"ok":true,"db":"up",...}` |
| 8 | Client | open `http://localhost:5173` | "Frontdesk" page showing `API ok, database up` |
| 9 | Production mode | Step 8 commands | HTML at `/`, JSON at `/api/*` |
| 10 | Clean from scratch | `npm run db:reset && npm run db:seed && npm test` | all green |

## 7. Troubleshooting (mistakes Copilot commonly makes here)

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module '.../tests'` on `npm test` | `node --test tests/` is not supported on Node 22 | Use plain `node --test` (already in `package.json`) |
| Error says `Failed query: ...` with no detail | Drizzle wraps the driver error | Read `err.cause.message` / `err.cause.code` |
| Copilot runs `drizzle-kit generate` and a duplicate `0003_*.sql` appears | Migrations already exist | Delete the new file **and** its `meta/` snapshot and journal entry (`git restore db/migrations`); do not regenerate |
| Copilot proposes `drizzle-kit push` | Wrong tool for this schema | Rule 2 in section 1: never. It cannot see triggers or views |
| Express: `Missing parameter name at ...` | Express 5 changed wildcards: `app.get('*')` is invalid | Use `app.get('/{*splat}', ...)` (already in `app.js`) |
| `config` throws `Missing required environment variable DATABASE_URL` | No `.env` | `cp .env.example .env` |
| `ECONNREFUSED` | Postgres not running | `docker compose up -d db` |
| `permission denied to create database` in tests | The DB user can't create databases | Use a local superuser URL in `TEST_DATABASE_URL` |
| `Refusing to run tests against non-local host` | Safety guard working | Point `TEST_DATABASE_URL` at a local Postgres. Only set `ALLOW_REMOTE_TEST_DB=true` for a disposable DB |
| `relation "..." does not exist` in a test | The test used `DATABASE_URL`'s db, not the throwaway | Always use `ctx.db` / `ctx.pool` from `createTestDb()` |
| DELETE/TRUNCATE "should fail" test passes without failing | Row-level trigger doesn't fire on an empty table | Insert a row first (as in `db.test.js`) |
| `count(*)` comes back as a string | `int8` parsing | Already handled in `db/client.js`. In raw SQL you can also cast `::int` |
| Tailwind classes have no effect | v3-style config, or missing `@import "tailwindcss"` | See the note in Step 7 |
| Vite not found when building on the host | devDependencies skipped | Keep `--include=dev` in the `build` script |
| Dates look wrong | A `Date` was formatted in server local time | Send ISO UTC; format in the UI with `timeZone: 'Asia/Kolkata'` |

## 8. Out of scope for this step

Business-time maths, auth and sessions, any ticket endpoints, the tick job, real UI screens, deployment itself. **Step 02 (the business-time and SLA engine) is next.** It is a pure module with no database access, so it can be built and tested in isolation.
