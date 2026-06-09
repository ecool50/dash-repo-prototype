#!/usr/bin/env node
// Local Node API server for option_b. Mirrors the Worker routes in api/ but
// runs as a plain Node process, so the mongodb driver works without bundle-size
// or compatibility constraints.
//
// Production target stays as the Cloudflare Worker in api/. This file is the
// dev entry point.
//
// Required env:
//   ATLAS_URI    mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority
//
// Optional env:
//   PORT         default 8787
//   EMBED_URL    default https://dash-embed-query.ecool50.workers.dev
//                (the embedding Worker that already exists for option_a)
//   ALLOWED_ORIGIN  default *
//
// Run: ATLAS_URI=... node scripts/dev-server.mjs
//   or: ATLAS_URI=... npm run dev

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
};

const PORT = Number(process.env.PORT) || 8787;
const EMBED_URL = process.env.EMBED_URL || 'https://dash-embed-query.ecool50.workers.dev';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const ATLAS_URI = process.env.ATLAS_URI;
if (!ATLAS_URI) { console.error('ATLAS_URI not set'); process.exit(1); }

const DEMO_USERS = {
  analyst:  { id: 'demo-analyst',  tier: 'analyst',  roles: ['lead_analyst'] },
  hdr:      { id: 'demo-hdr',      tier: 'hdr',      roles: [] },
  external: { id: 'demo-external', tier: 'external', roles: [] },
};

const mc = new MongoClient(ATLAS_URI);
await mc.connect();
const db = mc.db('dash');
const projects = db.collection('projects');
const searchLogs = db.collection('search_logs');
console.log(`Connected to Atlas. Listening on http://localhost:${PORT}`);

http.createServer(async (req, res) => {
  const cors = {
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-demo-user',
  };
  if (req.method === 'OPTIONS') return send(res, 204, cors);

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const user = resolveUser(req);

  try {
    if (req.method === 'POST' && url.pathname === '/api/query-embed') {
      const { query } = await readJson(req);
      const v = await embed(query);
      return send(res, 200, cors, { vector: v, dimensions: v.length, model: 'bge-large-en-v1.5' });
    }
    if (req.method === 'POST' && url.pathname === '/api/search') {
      const body = await readJson(req);
      return send(res, 200, cors, await search(body, user));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/projects/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      return send(res, 200, cors, await getProject(id, user));
    }

    // Static file serving for the frontend.
    if (req.method === 'GET') return serveStatic(url.pathname, res);

    return send(res, 404, cors, { error: 'not found' });
  } catch (e) {
    console.error(e);
    return send(res, 500, cors, { error: String(e?.message || e) });
  }
}).listen(PORT);

// --- Handlers ---------------------------------------------------------------

async function search({ query, filters = {}, limit = 10 }, user) {
  const merged = { ...buildFilters(filters), ...aclFilter(user) };

  let results;
  if (query) {
    const queryVector = await embed(query);
    const pipeline = [
      {
        $vectorSearch: {
          index: 'projects_vector',
          path: 'embedding.vector',
          queryVector,
          numCandidates: 100,
          limit,
          filter: merged,
        },
      },
      { $set: { score: { $meta: 'vectorSearchScore' } } },
      { $project: hideVector() },
    ];
    results = await projects.aggregate(pipeline).toArray();
  } else {
    results = await projects.find(merged, { projection: hideVector() })
      .sort({ updated_at: -1 }).limit(limit).toArray();
  }

  searchLogs.insertOne({
    query: query || null,
    filters,
    user_id: user?.id || null,
    user_tier: user?.tier || null,
    n_results: results.length,
    ts: new Date(),
  }).catch(() => {});

  return { results };
}

async function getProject(refNumber, user) {
  const doc = await projects.findOne(
    { ref_number: refNumber, ...aclFilter(user) },
    { projection: hideVector() }
  );
  if (!doc) throw new Error('not found or not accessible');
  return doc;
}

// --- Helpers ----------------------------------------------------------------

function buildFilters({ modality, disease, method, status } = {}) {
  const f = {};
  if (modality) f['project_details.data_modality'] = modality;
  if (disease)  f['project_details.disease'] = disease;
  if (method)   f['tags.method_tags'] = method;
  if (status)   f.status = status;
  return f;
}

function aclFilter(user) {
  if (!user) return { 'access.preset': 'public' };
  const identities = [
    `user:${user.id}`,
    `tier:${user.tier}`,
    ...(user.roles || []).map(r => `role:${r}`),
  ];
  return {
    $or: [
      { 'access.preset': 'public' },
      { 'access.viewers': { $in: identities } },
    ],
  };
}

function hideVector() {
  return { 'embedding.vector': 0, 'embedding._source_hash': 0 };
}

function resolveUser(req) {
  const demo = req.headers['x-demo-user'];
  return DEMO_USERS[demo] || null;
}

async function embed(query) {
  if (typeof query !== 'string' || !query) throw new Error('query required');
  const r = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`embed worker ${r.status}: ${await r.text()}`);
  const { vector } = await r.json();
  return vector;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(urlPath, res) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const fsPath = path.join(PROJECT_ROOT, decodeURIComponent(rel));
  if (!fsPath.startsWith(PROJECT_ROOT)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(fsPath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ct = MIME[path.extname(fsPath)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct });
    res.end(data);
  });
}

function send(res, status, cors, payload) {
  const headers = { ...cors };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  res.writeHead(status, headers);
  res.end(payload === undefined ? '' : JSON.stringify(payload));
}
