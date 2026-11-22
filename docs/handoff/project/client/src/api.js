// One place for all HTTP calls. Same-origin cookies carry the agent session (added in a later step).
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? res.statusText);
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}
