import { config } from './config.js';
import { createPool, createDb } from '../db/client.js';
import { createApp } from './app.js';

const pool = createPool();
const db = createDb(pool);
const customerPool = config.customerDatabaseUrl
  ? createPool(config.customerDatabaseUrl)
  : null;
const customerDb = customerPool ? createDb(customerPool) : db;

const app = createApp({
  db,
  customerDb,
  sessionSecret: config.sessionSecret,
  secureCookies: config.isProd,
});

const server = app.listen(config.port, () => {
  console.log(`Frontdesk API listening on :${config.port} (${config.env})`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => Promise.all([pool.end(), customerPool?.end()]).then(() => process.exit(0)));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
