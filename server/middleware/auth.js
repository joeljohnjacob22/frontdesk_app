import { and, eq } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import { HttpError } from '../lib/errors.js';
import { SESSION_COOKIE, parseCookies, verifySession } from '../lib/session.js';

export function loadSession({ db, secret }) {
  return async (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = verifySession(token, secret);
    if (session) {
      const [user] = await db.select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
      })
        .from(users)
        .where(and(eq(users.id, session.uid), eq(users.active, true)));
      if (user) req.user = user;
    }
    next();
  };
}

export function requireAgent(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'unauthenticated', 'Please sign in'));
  next();
}

export function requireLead(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'unauthenticated', 'Please sign in'));
  if (req.user.role !== 'lead') {
    return next(new HttpError(403, 'forbidden', 'Only a lead can do this'));
  }
  next();
}

export function sameOrigin(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {
      // Invalid origins are rejected below.
    }
    if (host !== req.get('host')) {
      return next(new HttpError(403, 'cross_origin_blocked', 'Cross-origin request blocked'));
    }
  }
  next();
}
