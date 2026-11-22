import { HttpError } from './errors.js';

function validationError(message) {
  throw new HttpError(400, 'validation_error', message);
}

export function requireString(value, field, { min = 1, max = 10_000 } = {}) {
  if (typeof value !== 'string') validationError(`${field} must be a string`);
  const text = value.trim();
  if (text.length < min || text.length > max) {
    validationError(`${field} must be between ${min} and ${max} characters`);
  }
  return text;
}

export function requireEmail(value, field = 'email') {
  const email = requireString(value, field, { max: 254 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    validationError(`${field} must be a valid email address`);
  }
  return email;
}

export function requireOneOf(value, field, allowed) {
  const text = requireString(value, field);
  if (!Array.isArray(allowed) || !allowed.includes(text)) {
    validationError(`${field} must be one of: ${Array.isArray(allowed) ? allowed.join(', ') : ''}`);
  }
  return text;
}

export function optionalBoolean(value, field, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') validationError(`${field} must be a boolean`);
  return value;
}

export function parseId(value) {
  const validString = typeof value === 'string' && /^\d+$/.test(value);
  const number = validString || typeof value === 'number' ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new HttpError(404, 'not_found', 'Not found');
  }
  return number;
}
