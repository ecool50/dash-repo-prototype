// Cloudflare Worker entry point for the DASH Repository mockup.
//
// Routes:
//   POST /api/query-embed   text -> vector (Workers AI bge-large-en-v1.5)
//   POST /api/search        { query, filters, limit } -> ranked projects
//   GET  /api/projects/:id  full project document
//   POST /api/ingest        validate, embed, upsert (Bearer INGEST_SECRET)
//
// RBAC is intentionally not in this build; Phase 1 launches public-by-default.

import { searchProjects, getProject } from './search.js';
import { ingestProject } from './ingest.js';

const EMBED_MODEL = '@cf/baai/bge-large-en-v1.5';

export default {
  async fetch(req, env) {
    const cors = corsHeaders(env);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (req.method === 'POST' && path === '/api/query-embed') {
        const { query } = await req.json();
        const result = await env.AI.run(EMBED_MODEL, { text: [query] });
        const vector = result?.data?.[0];
        return json({ vector, dimensions: vector?.length, model: 'bge-large-en-v1.5' }, 200, cors);
      }
      if (req.method === 'POST' && path === '/api/search') {
        const body = await req.json();
        return json(await searchProjects(body, env), 200, cors);
      }
      if (req.method === 'GET' && path.startsWith('/api/projects/')) {
        const id = decodeURIComponent(path.split('/').pop());
        return json(await getProject(id, env), 200, cors);
      }
      if (req.method === 'POST' && path === '/api/ingest') {
        const auth = req.headers.get('authorization') || '';
        const expected = `Bearer ${env.INGEST_SECRET || ''}`;
        if (!env.INGEST_SECRET || auth !== expected) {
          return json({ error: 'unauthorized' }, 401, cors);
        }
        const body = await req.json();
        return json(await ingestProject(body, env), 200, cors);
      }
      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500, cors);
    }
  },
};

function corsHeaders(env) {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
}

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  });
}
