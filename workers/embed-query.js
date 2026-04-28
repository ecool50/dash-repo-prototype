// Cloudflare Worker: embed text → vector via Cloudflare Workers AI.
//
// Deploy: wrangler deploy
// Bind:   [ai] binding = "AI" (configured in wrangler.toml)
//         ALLOWED_ORIGIN (var, e.g. https://ecool50.github.io)
//
// Frontend usage:
//   const r = await fetch(WORKER_URL, {
//     method: 'POST',
//     headers: { 'content-type': 'application/json' },
//     body: JSON.stringify({ query: '...' })
//   });
//   const { vector, dimensions, model } = await r.json();
//
// The Worker is the only server-side compute in Option A. It exists
// to keep the embedding model behind a single endpoint that both the
// browser frontend and the build-time embed.mjs script can call.

const MODEL = '@cf/baai/bge-large-en-v1.5';
const MODEL_LABEL = 'bge-large-en-v1.5';

export default {
  async fetch(req, env) {
    const cors = {
      'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    };

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405, cors);

    let query;
    try {
      ({ query } = await req.json());
    } catch {
      return json({ error: 'invalid JSON body' }, 400, cors);
    }

    if (!query || typeof query !== 'string' || query.length > 4000) {
      return json({ error: 'query must be a string under 4000 chars' }, 400, cors);
    }

    let result;
    try {
      result = await env.AI.run(MODEL, { text: [query] });
    } catch (e) {
      return json({ error: 'workers-ai upstream failed', detail: String(e) }, 502, cors);
    }

    const vector = result?.data?.[0];
    if (!Array.isArray(vector)) {
      return json({ error: 'no vector returned', raw: result }, 502, cors);
    }

    return json({ model: MODEL_LABEL, dimensions: vector.length, vector }, 200, cors);
  },
};

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  });
}
