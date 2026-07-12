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
import { expandAbbreviations } from './abbrev.js';

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
  // `query` is the topical phrase (the agent planner rewrites the user's words
  // into it). `raw` is the user's original text, when the caller has it: the
  // planner paraphrases a package name out of the topic ("which projects used
  // Seurat?" -> "single-cell analysis"), so the tool lookup must see the raw
  // text or it never sees the tool name at all.
  const { query, filters = {}, limit = 10, people, raw } = body || {};
  const matchFilter = buildFilters(filters);
  const hasQuery = typeof query === 'string' && query.trim().length > 0;
  const hasPeople = Array.isArray(people) && people.length > 0;

  let results;
  let weak = false;
  let toolHits = [];
  if (hasQuery || hasPeople) {
    results = [];
    if (hasQuery) {
      // Expand abbreviations once, then use the expanded text for BOTH the
      // embedding recall stage and the reranker — otherwise the cross-encoder
      // re-scores the original acronym (which it also doesn't understand) and
      // filters out the very matches the expanded embedding just recalled.
      const expanded = expandAbbreviations(query);
      const vec = await embedQuery(expanded, env);
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
      const reranked = await rerank(expanded, raw, env, limit);
      results = reranked.results;
      weak = reranked.weak;
    }
    // Supplement with structured investigator-name matches. The reranker scores
    // a name buried in a sentence ("projects X worked on") too low to surface,
    // so match names directly: explicit `people` (from the agent planner) when
    // given, otherwise name-like tokens from the raw query.
    const byName = await matchByInvestigator(hasQuery ? query : '', people, env);
    results = mergeByRef(results, byName, limit);
    // An exact investigator-name match is a confident hit, so the set is no
    // longer weak once one is present.
    if (byName.length) weak = false;

    // Same idea for a named tool/package, which the embedding stage misses.
    const toolText = (typeof raw === 'string' && raw.trim()) ? raw : (hasQuery ? query : '');
    if (toolText) {
      const byTool = await matchByTool(toolText, env);
      results = mergeByRef(results, byTool, limit);
      if (byTool.length) weak = false;
      // Which tool the query named, and exactly which projects list it. This is
      // set membership we have already computed exactly; the answer model is a
      // poor judge of it (asked for the projects using Seurat it will name one
      // of two, and miscount), so we hand it the resolved fact rather than
      // asking it to re-derive one. See toolFacts() in agent.js.
      toolHits = toolMatchDetail(toolText, byTool);
    }
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

  return { results, weak, toolHits };
}

// For each tool the query named, the projects that actually list it, resolved
// against the stored field rather than left to the model:
//   [{ tool: 'Seurat', refs: ['0040', '0046'] }]
// Only tools that the caller's text named AND some project lists appear here.
function toolMatchDetail(text, docs) {
  const tokens = new Set((String(text).toLowerCase().match(/[a-z][a-z0-9.-]{2,}/g) || []));
  const byTool = new Map();
  for (const d of docs) {
    for (const tool of d.analytical_methods?.tools_packages || []) {
      if (!tokens.has(String(tool).toLowerCase())) continue;
      if (!byTool.has(tool)) byTool.set(tool, []);
      byTool.get(tool).push(d.ref_number);
    }
  }
  return [...byTool.entries()].map(([tool, refs]) => ({ tool, refs }));
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
// Returns { results, weak }. `weak` is true when nothing cleared the strong
// floor and the results are rescue-tier only — the caller (agent) uses it to
// frame the answer honestly instead of presenting weak matches as confident.
async function rerank(query, rows, env, limit) {
  if (!rows || rows.length === 0) return { results: [], weak: false };
  const contexts = rows.map((r) => ({ text: r.embedding?.source_text || r.title || '' }));
  const rr = await env.AI.run(RERANK_MODEL, { query, contexts, top_k: rows.length });
  // bge-reranker-base on Workers AI returns relevance already in [0,1], sorted desc.
  const ranked = (rr?.response || [])
    .map((item) => ({ row: rows[item.id], score: item.score }))
    .filter((x) => x.row);
  // Primary: keep strong matches. If none clear the strong floor, rescue the
  // weaker-but-clearly-relevant ones rather than returning nothing, and flag
  // the set as weak.
  let kept = ranked.filter((x) => x.score >= RERANK_FLOOR);
  let weak = false;
  if (kept.length === 0) {
    kept = ranked.filter((x) => x.score >= RESCUE_FLOOR);
    weak = kept.length > 0;
  }
  return { results: kept.slice(0, limit).map((x) => ({ ...x.row, score: x.score })), weak };
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
    if (Array.isArray(people)) {
      // Explicit people from the planner. An empty array means the query names
      // no one, so skip the lookup entirely (saves a Mongo round-trip, and
      // thus a 1101-crash chance, on topical queries).
      tokens = [...new Set(people.flatMap((p) => String(p).toLowerCase().match(/[a-z]{3,}/g) || []))];
    } else {
      // No planner (direct /api/search): heuristic name-like tokens from the
      // raw query, minus generic words.
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

// Find projects that list a named tool/package from the query ("which projects
// used Seurat?", "anything with limma?"). Embeddings represent a package name
// poorly, so the vector stage misses these even though the field is indexed and
// exact: Seurat is on two projects but recalls only one.
//
// Matches a query token against a tool name in FULL (^token$), never as a
// prefix, so ordinary words cannot collide with a package: "single" matches no
// tool, while "seurat" matches exactly. Resilient: [] on any error.
async function matchByTool(query, env) {
  try {
    const tokens = [...new Set((String(query || '').toLowerCase().match(/[a-z][a-z0-9.-]{2,}/g) || [])
      .filter((t) => !NAME_STOPWORDS.has(t)))];
    if (!tokens.length) return [];
    const ors = tokens.map((t) => ({
      'analytical_methods.tools_packages': {
        $regex: `^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        $options: 'i',
      },
    }));
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
