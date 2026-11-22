import { HttpError } from './errors.js';

const fail = (message) => new HttpError(400, 'validation_error', message);

export function requireString(value, field, { min = 1, max = 10_000 } = {}) {
  if (typeof value !== 'string') throw fail(`${field} is required`);
  const text = value.trim();
  if (text.length < min) throw fail(`${field} is required`);
  if (text.length > max) throw fail(`${field} must be at most ${max} characters`);
  return text;
}

export function requireEmail(value, field = 'email') {
  const text = requireString(value, field, { max: 254 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw fail(`${field} is not a valid email address`);
  return text;
}

export function requireOneOf(value, field, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw fail(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

export function optionalBoolean(value, field, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw fail(`${field} must be true or false`);
  return value;
}

// Route ids: anything that is not a positive integer is simply "not found".
export function parseId(value) {
  if (!/^[1-9]\d{0,15}$/.test(String(value))) throw new HttpError(404, 'not_found', 'Not found');
  return Number(value);
}
