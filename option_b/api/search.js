// Search pipeline for /api/search and /api/projects/:id.
//
// Behavior:
//   - If `query` present: embed -> $vectorSearch with structured filters.
//   - If `query` absent:  $match only, sort by updated_at desc.
//   - Always: log to search_logs.
//
// `embedding.vector` is stripped from every result before return.
// RBAC is intentionally not applied in this mockup; Phase 1 launches
// public-by-default and access filtering is a Phase 2 addition.

import { client, DB, COLL } from './mongo.js';

const EMBED_MODEL = '@cf/baai/bge-large-en-v1.5';

export async function searchProjects(body, env) {
  const { query, filters = {}, limit = 10 } = body || {};
  const matchFilter = buildFilters(filters);

  let results;
  if (query) {
    const vec = await embed(query, env);
    const pipeline = [
      {
        $vectorSearch: {
          index: 'projects_vector',
          path: 'embedding.vector',
          queryVector: vec,
          numCandidates: 100,
          limit,
          filter: matchFilter,
        },
      },
      { $set: { score: { $meta: 'vectorSearchScore' } } },
      { $project: hideVector() },
    ];
    results = await client(env).aggregate(DB, COLL, pipeline);
  } else {
    results = await client(env).find(DB, COLL, matchFilter, {
      sort: { updated_at: -1 },
      limit,
      projection: hideVector(),
    });
  }

  // Fire-and-forget query log.
  logQuery(env, {
    query: query || null,
    filters,
    n_results: results.length,
  }).catch(() => {});

  return { results };
}

export async function getProject(id, env) {
  const docs = await client(env).find(DB, COLL, { ref_number: id }, {
    limit: 1,
    projection: hideVector(),
  });
  if (!docs.length) throw new Error('not found');
  return docs[0];
}

function buildFilters({ modality, disease, method, status } = {}) {
  const f = {};
  if (modality) f['project_details.data_modality'] = modality;
  if (disease)  f['project_details.disease'] = disease;
  if (method)   f['tags.method_tags'] = method;
  if (status)   f.status = status;
  return f;
}

function hideVector() {
  return { 'embedding.vector': 0, 'embedding._source_hash': 0 };
}

async function embed(query, env) {
  const r = await env.AI.run(EMBED_MODEL, { text: [query] });
  return r?.data?.[0];
}

async function logQuery(env, entry) {
  await client(env).insertOne(DB, 'search_logs', { ...entry, ts: new Date().toISOString() });
}
