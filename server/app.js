import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { sql } from 'drizzle-orm';
import { loadSession, sameOrigin } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { agentRoutes } from './routes/agent.js';
import { customerRoutes } from './routes/customer.js';
import { loadEngineConfig } from './lib/engineConfig.js';
import { createQueries } from './services/queries.js';
import { createTicketService } from './services/tickets.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({
  db,
  customerDb = db,
  getEngine = () => loadEngineConfig(db),
  clock,
  sessionSecret = 'dev-only-secret',
  secureCookies = false,
  clientDir = path.resolve(here, '../client/dist'),
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(sameOrigin);
  app.use(loadSession({ db, secret: sessionSecret }));

  const svc = createTicketService({ db, getEngine, ...(clock ? { clock } : {}) });
  const queries = createQueries({ db, customerDb, ...(clock ? { clock } : {}) });

  app.get('/api/health', async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ ok: true, db: 'up', time: new Date().toISOString() });
    } catch (err) {
      console.error('health check failed:', err.cause?.message ?? err.message);
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  app.use('/api/auth', authRoutes({ db, secret: sessionSecret, secureCookies }));
  app.use('/api/agent', agentRoutes({ svc, queries }));
  app.use('/api/customer', customerRoutes({ svc, queries }));

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
    let status = err.status ?? 500;
    let code = typeof err.code === 'string' && status < 500 ? err.code : 'internal_error';
    if (err.type === 'entity.parse.failed') {
      status = 400;
      code = 'invalid_json';
    }
    if (status >= 500) console.error(err.cause?.message ?? err.stack ?? err);
    res.status(status).json({
      error: {
        code,
        message: status < 500
          ? (code === 'invalid_json' ? 'Request body is not valid JSON' : err.message)
          : 'Something went wrong',
      },
    });
  });

  return app;
}
