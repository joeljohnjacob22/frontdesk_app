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