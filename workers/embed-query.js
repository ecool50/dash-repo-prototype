// Cloudflare Worker: embed user query → vector
//
// Deploy: wrangler deploy
// Bind:   OPENAI_API_KEY (secret)
//         ALLOWED_ORIGIN (var, e.g. https://cpc-dash.github.io)
//
// Frontend usage:
//   const r = await fetch(WORKER_URL, {
//     method: 'POST',
//     headers: { 'content-type': 'application/json' },
//     body: JSON.stringify({ query: '...' })
//   });
//   const { vector } = await r.json();
//
// The Worker is the only piece of server-side compute in Option A. It exists
// solely to keep the OpenAI API key out of the browser. Everything else
// (project records, search index, vector similarity) is static / client-side.

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

    if (!query || typeof query !== 'string' || query.length > 2000) {
      return json({ error: 'query must be a string under 2000 chars' }, 400, cors);
    }

    const upstream = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: query,
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return json({ error: 'embedding upstream failed', status: upstream.status, detail }, 502, cors);
    }

    const body = await upstream.json();
    const vector = body?.data?.[0]?.embedding;
    if (!Array.isArray(vector)) return json({ error: 'no vector returned' }, 502, cors);

    return json({ model: 'text-embedding-3-small', dimensions: vector.length, vector }, 200, cors);
  },
};

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  });
}
