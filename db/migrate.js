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
    console.error('Migration failed:', err.cause?.message || err.message || err.code || err.name);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}