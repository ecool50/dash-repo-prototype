// Thin wrapper over /api/*. Sets the demo user header.

const API_BASE = window.DASH_API_BASE || 'http://localhost:8787';

export async function search({ query, filters, limit }, demoUser) {
  return post('/api/search', { query, filters, limit }, demoUser);
}

export async function getProject(id, demoUser) {
  return get(`/api/projects/${encodeURIComponent(id)}`, demoUser);
}

async function post(path, body, demoUser) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: headers(demoUser),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function get(path, demoUser) {
  const r = await fetch(`${API_BASE}${path}`, { headers: headers(demoUser) });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

function headers(demoUser) {
  return {
    'content-type': 'application/json',
    'x-demo-user': demoUser || 'external',
  };
}
