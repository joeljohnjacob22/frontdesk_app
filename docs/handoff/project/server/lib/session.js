import crypto from 'node:crypto';

// Stateless signed session cookie: base64url(JSON payload) + "." + HMAC-SHA256 signature.
// No dependency needed. Payload: { uid, exp } with exp in epoch SECONDS.
export const SESSION_COOKIE = 'fd_session';
export const SESSION_MAX_AGE_S = 12 * 60 * 60;

const mac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

// Returns the payload, or null for anything wrong (bad format, bad signature, expired).
export function verifySession(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const given = Buffer.from(parts[1]);
  const expected = Buffer.from(mac(parts[0], secret));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { return null; }
  if (!payload || typeof payload.uid !== 'number' || typeof payload.exp !== 'number') return null;
  if (payload.exp * 1000 <= nowMs) return null;
  return payload;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(value, { maxAge = SESSION_MAX_AGE_S, secure = false } = {}) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
