import crypto from 'node:crypto';

export function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest();
}

export function bodyHash(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}
