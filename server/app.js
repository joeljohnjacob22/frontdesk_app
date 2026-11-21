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
