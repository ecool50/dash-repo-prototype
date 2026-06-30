// Search pipeline for /api/search and /api/projects/:id.
//
// Behavior:
//   - If `query` present: embed -> $vectorSearch with structured filters.
//   - If `query` absent:  $match only, sort by updated_at desc.
//   - Vector search is the recall stage; a cross-encoder reranker then
//     scores true query/passage relevance, reorders, and drops
//     non-sensible matches below a calibrated floor.
//   - Always: log to search_logs.
//
// `embedding.vector` is stripped from every result before return.
// RBAC is intentionally not applied in this mockup; Phase 1 launches
// public-by-default and access filtering is a Phase 2 addition.

import { client, DB, COLL } from './mongo.js';

const EMBED_MODEL = '@cf/baai/bge-large-en-v1.5';
const RERANK_MODEL = '@cf/baai/bge-reranker-base';

// bge-large is an asymmetric retrieval model: the query carries a short
// instruction, the stored passages do not. Documents were ingested without
// one (ingest.js), so adding this is query-side only and needs no re-embed.
const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';

// Two-stage retrieval:
//   1. $vectorSearch is the recall net: pull OVERFETCH candidates by cosine.
//   2. A cross-encoder reranker (bge-reranker-base) reads the query and each
//      candidate's source_text together and scores true relevance. A
//      cross-encoder discriminates far better than bi-encoder cosine, so it
//      both reorders results and rejects the wrong-domain / tail matches that
//      a cosine floor + relative gap used to let through.
//
// bge-reranker-base returns a relevance score already in [0,1] per
// candidate. RERANK_FLOOR is the probability below which a match is treated
// as noise. Calibrated against the 10 illustrative projects (June 2026):
// true matches score 0.20 to 0.999, off-topic / noise tops out near 0.06.
// A floor of 0.1 sits in that gap: it keeps weak-but-valid matches (e.g.
// "cancer" -> the colorectal project at 0.20) while dropping wrong-domain
// tails and returning empty for nonsense. Judged per query/passage pair, so
// it is robust to corpus growth in a way the old absolute cosine floor was
// not. Re-tune if the reranker model changes.
const RERANK_FLOOR = 0.1;
// When nothing clears RERANK_FLOOR, rescue results above this lower bar. Catches
// paraphrase matches (e.g. "inflammatory skin" vs the doc's "atopic dermatitis",
// which reranks ~0.06) and investigator-name matches, whose absolute rerank
// score is low but which still stand well above the ~0.001 noise tail.
const RESCUE_FLOOR = 0.03;
const OVERFETCH_FACTOR = 4;
const MIN_OVERFETCH = 20;

export async function searchProjects(body, env) {
  const { query, filters = {}, limit = 10, people } = body || {};
  const matchFilter = buildFilters(filters);
  const hasQuery = typeof query === 'string' && query.trim().length > 0;
  const hasPeople = Array.isArray(people) && people.length > 0;

  let results;
  if (hasQuery || hasPeople) {
    results = [];
    if (hasQuery) {
      const vec = await embedQuery(query, env);
      // Overfetch a candidate net from Atlas, then let the reranker score
      // relevance and truncate to the caller's requested limit.
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
        { $set: { vector_score: { $meta: 'vectorSearchScore' } } },
        { $project: hideVector() },
      ];
      const raw = await client(env).aggregate(DB, COLL, pipeline);
      results = await rerank(query, raw, env, limit);
    }
    // Supplement with structured investigator-name matches. The reranker scores
    // a name buried in a sentence ("projects X worked on") too low to surface,
    // so match names directly: explicit `people` (from the agent planner) when
    // given, otherwise name-like tokens from the raw query.
    const byName = await matchByInvestigator(hasQuery ? query : '', people, env);
    results = mergeByRef(results, byName, limit);
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

// All ref_numbers currently in the collection. Used by the catalog-sync CI
// to reconcile deletions (delete any Atlas ref no longer in the repo).
export async function listProjectRefs(env) {
  const docs = await client(env).find(DB, COLL, {}, { projection: { ref_number: 1, _id: 0 } });
  return { refs: docs.map((d) => d.ref_number).filter(Boolean) };
}

export async function getProject(id, env) {
  const docs = await client(env).find(DB, COLL, { ref_number: id }, {
    limit: 1,
    projection: hideVector(),
  });
  if (!docs.length) throw new Error('not found');
  return docs[0];
}

// Cross-encoder rerank of the vector-search candidates. Reorders by true
// query/passage relevance and drops anything below RERANK_FLOOR. Replaces
// the old cosine floor + relative-gap heuristic. Sets `score` to the [0,1]
// relevance probability; keeps `vector_score` for debugging.
async function rerank(query, rows, env, limit) {
  if (!rows || rows.length === 0) return [];
  const contexts = rows.map((r) => ({ text: r.embedding?.source_text || r.title || '' }));
  const rr = await env.AI.run(RERANK_MODEL, { query, contexts, top_k: rows.length });
  // bge-reranker-base on Workers AI returns relevance already in [0,1], sorted desc.
  const ranked = (rr?.response || [])
    .map((item) => ({ row: rows[item.id], score: item.score }))
    .filter((x) => x.row);
  // Primary: keep strong matches. If none clear the strong floor, rescue the
  // weaker-but-clearly-relevant ones rather than returning nothing.
  let kept = ranked.filter((x) => x.score >= RERANK_FLOOR);
  if (kept.length === 0) kept = ranked.filter((x) => x.score >= RESCUE_FLOOR);
  return kept.slice(0, limit).map((x) => ({ ...x.row, score: x.score }));
}

// Query words stripped before matching against investigator names, so generic
// phrasing ("projects that ... worked on") does not match a person.
const NAME_STOPWORDS = new Set([
  'the', 'that', 'this', 'and', 'for', 'with', 'project', 'projects', 'work',
  'worked', 'working', 'show', 'find', 'finding', 'looking', 'look', 'past',
  'dash', 'who', 'what', 'which', 'was', 'were', 'are', 'did', 'done', 'some',
  'any', 'all', 'from', 'about', 'please', 'related', 'involving', 'involved',
  'study', 'studies', 'analysis', 'data', 'team', 'people', 'person', 'when',
  'researcher', 'analyst', 'his', 'her', 'their', 'they', 'has', 'have', 'where',
]);

// Find projects whose investigator fields contain a name-like query token.
// Resilient: returns [] on any error so a flaky lookup never fails the search.
async function matchByInvestigator(query, people, env) {
  try {
    let tokens;
    if (Array.isArray(people) && people.length) {
      // Explicit names from the planner: tokenise them, no stopword filter.
      tokens = [...new Set(people.flatMap((p) => String(p).toLowerCase().match(/[a-z]{3,}/g) || []))];
    } else {
      // Heuristic: name-like tokens from the raw query, minus generic words.
      tokens = [...new Set((String(query || '').toLowerCase().match(/[a-z]{3,}/g) || [])
        .filter((t) => !NAME_STOPWORDS.has(t)))];
    }
    if (!tokens.length) return [];
    const fields = [
      'investigators.lead_data_scientist',
      'investigators.collaborator',
      'investigators.research_leader',
      'investigators.analyst_team',
    ];
    const ors = [];
    for (const t of tokens) {
      const rx = { $regex: `\\b${t}`, $options: 'i' };
      for (const f of fields) ors.push({ [f]: rx });
    }
    return await client(env).find(DB, COLL, { $or: ors }, { projection: hideVector(), limit: 10 });
  } catch {
    return [];
  }
}

// Append `extra` docs not already present in `primary` (dedup on ref_number).
function mergeByRef(primary, extra, limit) {
  const seen = new Set(primary.map((r) => r.ref_number));
  const out = primary.slice();
  for (const d of extra) {
    if (out.length >= limit) break;
    if (!seen.has(d.ref_number)) { out.push(d); seen.add(d.ref_number); }
  }
  return out.slice(0, limit);
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

async function embedQuery(query, env) {
  const r = await env.AI.run(EMBED_MODEL, { text: [QUERY_INSTRUCTION + query] });
  return r?.data?.[0];
}

async function logQuery(env, entry) {
  await client(env).insertOne(DB, 'search_logs', { ...entry, ts: new Date().toISOString() });
}
