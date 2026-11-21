import assert from 'node:assert/strict';

// Drizzle wraps driver errors ("Failed query: ..."). The Postgres message/code is on err.cause.
export function rejectsPg(promise, pattern) {
  return assert.rejects(promise, (err) => pattern.test(err.cause?.message ?? err.message));
}
