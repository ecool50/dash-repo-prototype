// Search pipeline for /api/search and /api/projects/:id.
//
// Behavior:
//   - If `query` present: embed -> $vectorSearch with structured filters.
//   - If `query` absent:  $match only, sort by updated_at desc.
//   - Vector results are post-filtered by an absolute similarity floor
//     and a relative-gap cutoff so nonsense queries return empty rather
//     than top-K of whatever happens to be closest.
//   - Always: log to search_logs.
//
// `embedding.vector` is stripped from every result before return.
// RBAC is intentionally not applied in this mockup; Phase 1 launches
// public-by-default and access filtering is a Phase 2 addition.

import { client, DB, COLL } from './mongo.js';

const EMBED_MODEL = '@cf/baai/bge-large-en-v1.5';

// Retrieval thresholds (ported from the option_a prototype after tuning):
//   SIMILARITY_FLOOR — absolute cosine-similarity floor. Below this the
//     match is treated as noise. Tuned for bge-large-en-v1.5.
//   RELATIVE_GAP — once the best result is known, drop anything more
//     than this far behind it. Stops a single strong match from dragging
//     in a tail of weak ones.
//   OVERFETCH_FACTOR — how many extra candidates to pull from Atlas
//     before filtering, so the floor and gap have something to work with.
const SIMILARITY_FLOOR = 0.50;
const RELATIVE_GAP = 0.08;
const OVERFETCH_FACTOR = 4;
const MIN_OVERFETCH = 20;

export async function searchProjects(body, env) {
  const { query, filters = {}, limit = 10 } = body || {};
  const matchFilter = buildFilters(filters);

  let results;
  if (query) {
    const vec = await embed(query, env);
    // Overfetch from Atlas, then apply the absolute + relative thresholds
    // and truncate to the caller's requested limit.
    const overfetch = Math.max(limit * OVERFETCH_FACTOR, MIN_OVERFETCH);
    const pipeline = [
      {
        $vectorSearch: {
          index: 'projects_vector',
          path: 'embedding.vector',
          queryVector: vec,
          numCandidates: 200,
          limit: overfetch,
          filter: matchFilter,
        },
      },
      { $set: { score: { $meta: 'vectorSearchScore' } } },
      { $project: hideVector() },
    ];
    const raw = await client(env).aggregate(DB, COLL, pipeline);
    results = applyThresholds(raw).slice(0, limit);
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

function applyThresholds(rows) {
  if (!rows || rows.length === 0) return [];
  // 1) absolute floor: drop anything below the noise threshold
  const aboveFloor = rows.filter((r) => typeof r.score === 'number' && r.score >= SIMILARITY_FLOOR);
  if (aboveFloor.length === 0) return [];
  // 2) relative cutoff: drop anything more than RELATIVE_GAP behind the best
  const bestScore = aboveFloor[0].score;
  const cutoff = Math.max(SIMILARITY_FLOOR, bestScore - RELATIVE_GAP);
  return aboveFloor.filter((r) => r.score >= cutoff);
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
