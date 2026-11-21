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
