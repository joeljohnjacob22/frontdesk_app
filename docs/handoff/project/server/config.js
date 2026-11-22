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
