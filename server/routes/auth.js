import bcrypt from 'bcryptjs';
import express from 'express';
import { sql } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { SESSION_MAX_AGE_S, signSession, sessionCookie } from '../lib/session.js';
import { requireEmail, requireString } from '../lib/validate.js';
import { requireAgent } from '../middleware/auth.js';

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export function authRoutes({ db, secret, secureCookies }) {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    const email = requireEmail(req.body?.email);
    const password = requireString(req.body?.password, 'password', { max: 200 });
    const [user] = await db.select().from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    const matches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.active || !matches) {
      throw new HttpError(401, 'invalid_credentials', 'Wrong email or password');
    }

    const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S;
    res.setHeader('Set-Cookie', sessionCookie(
      signSession({ uid: user.id, exp }, secret),
      { secure: secureCookies },
    ));
    res.json({ user: publicUser(user) });
  });

  router.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', sessionCookie('', { maxAge: 0, secure: secureCookies }));
    res.status(204).end();
  });

  router.get('/me', requireAgent, (req, res) => res.json({ user: req.user }));

  return router;
}
