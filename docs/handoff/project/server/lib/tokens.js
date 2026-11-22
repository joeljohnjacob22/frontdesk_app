import crypto from 'node:crypto';

// The customer's secret link token. 24 random bytes = 192 bits: unguessable.
export const newToken = () => crypto.randomBytes(24).toString('base64url');

// Only this hash is stored (tickets.access_token_hash). A leaked database cannot rebuild a working link.
// Plain SHA-256 is correct here (unlike for passwords) because the token is long and random.
export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest();

// Audit events store this instead of the message text.
export const bodyHash = (body) => crypto.createHash('sha256').update(body).digest('hex');
