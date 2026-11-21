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
    options: '-c timezone=UTC',
    ...options,
  });
  pool.on('error', (err) => console.error('Unexpected pg pool error:', err));
  return pool;
}

export function createDb(pool) {
  return drizzle(pool, { schema });
}