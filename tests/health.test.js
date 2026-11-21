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
  assert.match(body.time, /Z$/);
});

test('unknown /api route returns the JSON error shape', async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: { code: 'not_found', message: 'No such API route' } });
});
