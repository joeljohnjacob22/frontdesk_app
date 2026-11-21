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
