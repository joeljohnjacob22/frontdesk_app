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