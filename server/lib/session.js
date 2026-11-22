import crypto from 'node:crypto';

export const SESSION_COOKIE = 'frontdesk_session';
export const SESSION_MAX_AGE_S = 12 * 60 * 60;

function signature(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest();
}

export function signSession(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signed = signature(encoded, secret).toString('base64url');
  return `${encoded}.${signed}`;
}

export function verifySession(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string' || typeof secret !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encoded, suppliedSignature] = parts;
  let actualSignature;
  try {
    actualSignature = Buffer.from(suppliedSignature, 'base64url');
  } catch {
    return null;
  }
  const expectedSignature = signature(encoded, secret);
  if (actualSignature.length !== expectedSignature.length
      || !crypto.timingSafeEqual(actualSignature, expectedSignature)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!payload
      || !Number.isSafeInteger(payload.uid)
      || payload.uid <= 0
      || !Number.isSafeInteger(payload.exp)
      || !Number.isFinite(nowMs)
      || payload.exp <= nowSeconds) {
    return null;
  }
  return payload;
}

export function parseCookies(header = '') {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const equalsAt = part.indexOf('=');
    if (equalsAt < 0) continue;
    const name = part.slice(0, equalsAt).trim();
    if (!name) continue;
    cookies[name] = part.slice(equalsAt + 1).trim();
  }
  return cookies;
}

export function sessionCookie(value, { maxAge = SESSION_MAX_AGE_S, secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
