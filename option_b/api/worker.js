// Cloudflare Worker entry point for the DASH Repository mockup.
//
// Routes:
//   POST /api/query-embed   text -> vector (Workers AI bge-large-en-v1.5)
//   POST /api/search        { query, filters, limit } -> ranked projects
//   POST /api/ask           { query, limit } -> { answer, matches }
//                           Frontend-facing wrapper around search with a
//                           short templated answer string.
//   GET  /api/projects     list all ref_numbers (catalog reconcile)
//   GET  /api/projects/:id  full project document
//   DELETE /api/projects/:id remove a project by ref (Bearer INGEST_SECRET)
//   POST /api/ingest        validate, embed, upsert (Bearer INGEST_SECRET)
//
// RBAC is intentionally not in this build; Phase 1 launches public-by-default.

import { searchProjects, getProject, listProjectRefs } from './search.js';
import { ingestProject, deleteProject } from './ingest.js';
import { askStream } from './ask.js';

// The MongoDB driver + connection live in this Durable Object, not the
// stateless request path. Must be exported from the Worker entry module.
export { MongoDO } from './mongo-do.js';

const EMBED_MODEL = '@cf/baai/bge-large-en-v1.5';

export default {
  async fetch(req, env) {
    const cors = corsHeaders(env, req);
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
      if (req.method === 'POST' && path === '/api/ask') {
        const body = await req.json();
        return streamAsk(body, env, cors);
      }
      if (req.method === 'GET' && path === '/api/projects') {
        return json(await listProjectRefs(env), 200, cors);
      }
      if (req.method === 'GET' && path.startsWith('/api/projects/')) {
        const id = decodeURIComponent(path.split('/').pop());
        return json(await getProject(id, env), 200, cors);
      }
      if (req.method === 'DELETE' && path.startsWith('/api/projects/')) {
        const auth = req.headers.get('authorization') || '';
        if (!env.INGEST_SECRET || auth !== `Bearer ${env.INGEST_SECRET}`) {
          return json({ error: 'unauthorized' }, 401, cors);
        }
        const id = decodeURIComponent(path.split('/').pop());
        return json(await deleteProject(id, env), 200, cors);
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

// ALLOWED_ORIGIN is a comma-separated allowlist (or "*"). The matching
// request origin is echoed back; non-matching origins get no CORS headers.
function corsHeaders(env, req) {
  const base = {
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim());
  if (allowed.includes('*')) {
    return { ...base, 'access-control-allow-origin': '*' };
  }
  const origin = req.headers.get('origin');
  if (origin && allowed.includes(origin)) {
    return { ...base, 'access-control-allow-origin': origin, vary: 'origin' };
  }
  return base;
}

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  });
}

// Streams /api/ask as newline-delimited JSON (NDJSON): one event object per
// line — { type: 'matches' | 'token' | 'done' | 'error', ... }. The body stays
// open while askStream produces events, so the answer streams token-by-token
// and the matched cards arrive the moment the search tool returns.
function streamAsk(body, env, cors) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const emit = (obj) => writer.write(enc.encode(JSON.stringify(obj) + '\n'));

  (async () => {
    try {
      await askStream(body, env, emit);
    } catch (e) {
      await emit({ type: 'error', error: String(e?.message || e) });
    } finally {
      try { await emit({ type: 'done' }); } catch { /* stream already closed */ }
      await writer.close();
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: { ...cors, 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
  });
}
