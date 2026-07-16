// catalogue.js — the EXACT / structured query path for /api/ask (WS2).
//
// WHY THIS FILE EXISTS
// --------------------
// The rest of the agent answers questions by semantic retrieval: embed the
// query, pull the nearest projects by cosine, rerank, and let the model phrase
// an answer over that slice (see search.js, agent.js). That is the right tool
// for FUZZY questions ("projects about skin inflammation") where no exact
// keyword appears. It is the WRONG tool for EXACT questions, for two reasons a
// better model cannot fix:
//
//   1. A vector search returns a similarity-ranked top-K. It has no notion of
//      "all". So counting ("how many projects?"), exhaustive listing ("list
//      every project"), and by-category breakdowns ("summarise by data type")
//      are unanswerable from it by construction — the query never assembles the
//      whole catalogue to count over. Asked such a question with only a top-K
//      slice in context, the model fills the gap from its priors and INVENTS
//      numbers. That is exactly the "5 transcriptomics projects / 12 single-cell
//      projects" hallucination this file removes (only 11 projects exist).
//
//   2. Embeddings recall imperfectly. A relevant project can score just under
//      the reranker floor and silently vanish, or a value like a package name
//      embeds poorly (see search.js matchByTool). So even a category retrieval
//      that "worked" once ("list transcriptomics projects" -> 2 results) is
//      fragile and may be incomplete.
//
// THE PRINCIPLE: match the retrieval mechanism to the query type. Anything
// exact or catalogue-wide is answered by a direct query over ALL documents in
// Mongo, and the numbers ALWAYS originate in the database, never in the model.
// The model, if used at all here, only wraps a pre-computed, DB-derived fact in
// a sentence. This makes the count-hallucination structurally impossible.
//
// WHAT THIS FILE DOES
// -------------------
//   classifyCatalogue(text) -> null | intent      (deterministic, no model)
//   runCatalogue(intent, env) -> grounded result   (one Mongo read over all docs)
//
// If classifyCatalogue returns non-null, ask.js routes the turn here and never
// touches embed / vector / rerank / the planner. See agent.js streamAggregate
// for how the result is turned into a grounded answer.

import { client, DB, COLL } from './mongo.js';

// ---------------------------------------------------------------------------
// PROPOSED DATA-TYPE TAXONOMY  <-- REVIEW ME
// ---------------------------------------------------------------------------
// The catalogue's `project_details.data_modality` is FREE TEXT, not a controlled
// vocabulary. Across the 11 live projects (July 2026) there are ~34 distinct
// modality strings, nearly all unique, mixing assay type, data representation,
// and biological readout. Grouping on the raw field therefore yields ~34 buckets
// of size 1 — exact, but useless as a "summary by data type".
//
// To answer "by data type" meaningfully we bucket each raw modality string into
// one of a small set of high-level DATA TYPES. THAT MAPPING IS A JUDGEMENT CALL
// and it changes the counts (e.g. is 10x Xenium "transcriptomics", "imaging", or
// "spatial"? here it is transcriptomics, because "spatial" is a cross-cutting
// attribute, not a data type). Every assignment below is derived from the actual
// 11-project catalogue and is meant to be reviewed and edited by the DASH team.
// This is the ONE constant to change to re-scope the taxonomy.
//
// `match`  : lowercased substrings; if a raw data_modality value CONTAINS any of
//            them, that value (and its project) counts toward this data type.
// `query`  : lowercased terms a USER might type to ask for this data type; used
//            by the category-retrieval path ("list all transcriptomics projects").
//
// A project may map to more than one data type (0037 is proteomics AND imaging),
// so per-type project counts DO NOT sum to the catalogue total. Every consumer
// of this taxonomy must state that; see runCatalogue and agent.js AGG_SYS.
const DATA_TYPES = [
  {
    canonical: 'transcriptomics',
    label: 'Transcriptomics',
    // 0040 (Xenium single-cell), 0046 (spatial transcriptomics), 0052 (bulk +
    // single-cell RNA-seq). NB: the RNA-seq strings contain no "transcriptom",
    // which is why substring matching alone missed 0052 in the reported session.
    match: [
      'transcriptom', 'rna-seq', 'rna seq', 'rnaseq', 'scrna',
      'single-cell spatial gene expression', 'gene expression',
      'xenium', 'cell-by-gene', 'gene counts', 'exon counts', 'pseudo-bulk',
    ],
    query: [
      'transcriptomic', 'transcriptomics', 'rna-seq', 'rnaseq', 'rna seq',
      'scrna', 'sc-rna', 'single-cell rna', 'single cell rna', 'gene expression',
      'xenium',
    ],
  },
  {
    canonical: 'proteomics',
    label: 'Proteomics',
    // 0055 (DIA mass spec proteomics), 0037 (spatial proteomics).
    match: ['proteom', 'mass spectrometry', 'mass spec', 'protein intensity'],
    query: ['proteomic', 'proteomics', 'mass spectrometry', 'mass spec'],
  },
  {
    canonical: 'epigenomics',
    label: 'Epigenomics (chromatin / CUT&RUN)',
    // 0042 and 0076 (CUT&RUN, histone marks H3K4me2 / H3K27me3, promoter peaks).
    match: [
      'cut&run', 'cut & run', 'cutandrun', 'peak-by-sample', 'peak signal',
      'histone', 'h3k', 'promoter-associated', 'promoter peak', 'chromatin',
    ],
    query: ['epigenom', 'epigenetic', 'cut&run', 'cut and run', 'chip', 'histone', 'chromatin'],
  },
  {
    canonical: 'imaging',
    label: 'Imaging',
    // 0037 (imaging mass cytometry, multiplexed tissue imaging).
    match: ['imaging mass cytometry', 'multiplexed tissue imaging', 'tissue imaging'],
    query: ['imaging', 'imaging mass cytometry', 'imc', 'multiplexed imaging'],
  },
  {
    canonical: 'clinical_meta',
    label: 'Clinical / meta-analysis',
    // 0051 (systematic review, survival/radiotherapy outcomes, hazard ratios),
    // 0057 (eating-disorder screening, sample-size / clinical measurement).
    match: [
      'systematic review', 'clinical outcome', 'survival outcome', 'radiotherapy',
      'hazard ratio', 'confidence interval', 'literature',
    ],
    query: [
      'clinical', 'meta-analysis', 'meta analysis', 'systematic review',
      'survival', 'outcomes', 'epidemiolog',
    ],
  },
  {
    canonical: 'wearable_sensor',
    label: 'Wearable / sensor',
    // 0047 (self-supervised learning on accelerometer / wrist / thigh sensors).
    match: ['wearable', 'accelerometer', 'wrist sensor', 'thigh sensor', 'sensor data'],
    query: ['wearable', 'sensor', 'accelerometer', 'actigraph', 'time series'],
  },
  {
    // NON-ASSAY type. Some DASH consults generate no data of their own — they
    // are pure statistics / study-design work (e.g. 0057, a sample-size and
    // power analysis for a screening-tool validation, whose data_modality is
    // legitimately empty). `nonAssay: true` means this type is NOT matched
    // against data_modality; projectDataTypes() applies it as a FALLBACK, only
    // when a project matched no assay type, scanning research_area +
    // primary_methods instead. Add other methods-only categories here the same
    // way if the catalogue grows to include them.
    canonical: 'study_design',
    label: 'Study design / biostatistics',
    nonAssay: true,
    match: [
      'sample size', 'sample-size', 'statistical power', 'power analysis',
      'power simulation', 'study design', 'study-design', 'diagnostic test accuracy',
      'diagnostic accuracy', 'binomial test', 'mcnemar', 'biostatistic',
    ],
    // Deliberately NARROW. "sample size" / "power analysis" are excluded here
    // (though kept in `match`) because they also phrase single-project field
    // questions ("what is the sample size of the X project?"), which must go to
    // semantic retrieval, not a category enumeration.
    query: ['study design', 'study-design', 'biostatistic'],
  },
];

// The canonical type slugs, exported as the single source of truth for the LLM
// router's data_type enum (router.js). Keeping the enum derived from the same
// taxonomy the executor uses means the router can never emit a type the
// executor doesn't understand.
export const CANONICAL_DATA_TYPES = DATA_TYPES.map((t) => t.canonical);

// Canonical slugs whose synonyms actually appear in the text. Used as the
// cross-check guard on the LLM router: if the router says intent=category with
// data_type X but X's synonyms are nowhere in the query, we distrust it and
// downgrade to semantic search rather than return a confidently-wrong category.
export function dataTypesInText(text) {
  const q = String(text || '').toLowerCase();
  return DATA_TYPES.filter((t) => t.query.some((syn) => q.includes(syn))).map((t) => t.canonical);
}

// The subset of docs belonging to a canonical data type (any modality string
// maps to it). Used by search.js categoryRanked for filter-then-semantic-rank.
export function projectsOfType(docs, type) {
  return (docs || []).filter((d) => projectDataTypes(d).has(type));
}

// The stored fields each facet groups on. Kept here so the pipeline and the
// classifier agree on one source of truth.
const FACET_FIELD = {
  disease: 'project_details.disease',
  tool: 'analytical_methods.tools_packages',
  method: 'analytical_methods.primary_methods',
};

// ---------------------------------------------------------------------------
// CLASSIFIER (deterministic — never the flaky model)
// ---------------------------------------------------------------------------
// Returns null when the turn is NOT a catalogue/exact query (so ask.js falls
// through to the normal planner + semantic search), or one of:
//   { kind: 'total' }                          how many projects in total
//   { kind: 'list' }                           list every project
//   { kind: 'group', facet }                   breakdown; facet in
//                                              data_type|disease|tool|method
//   { kind: 'category', facet:'data_type',     projects OF a named data type
//     type }                                   (the "transcriptomics" case);
//                                              also serves "how many X projects"
//
// Precedence matters and is applied in this order: group (facet breakdown) ->
// category (a named type) -> list (all) -> total (count). This keeps
// "how many projects by data type" (group) distinct from "how many
// transcriptomics projects" (category) and "how many projects" (total).
export function classifyCatalogue(text) {
  const q = String(text || '').toLowerCase().trim();
  if (!q) return null;

  // Negation guard: a deterministic exact answer for "projects that are NOT
  // transcriptomics" / "excluding proteomics" would otherwise be computed by
  // the (affirmative) category/group logic and returned INVERTED — a confident,
  // DB-grounded, exactly-wrong answer. We do not attempt to compute complements
  // here; we fall through to semantic search, which degrades gracefully.
  if (/\bnot\b|\bnon-|\bwithout\b|\bexcluding\b|\bexclude\b|\bexcept\b|\bother than\b|n't\b/.test(q)) {
    return null;
  }

  const mentionsProjects = /\b(projects?|studies|study|analyses|work|entries|catalogue|catalog|database|repo(?:sitory)?|everything)\b/.test(q);
  const aggregateVerb = /\b(how many|number of|count|counts|breakdown|break down|distribution|summar(?:y|ise|ize)|group(?:ed)? by|grouped|per|tally|split)\b/.test(q);
  // Enumerate verbs include retrieval verbs (retrieve/find/get/...) so that
  // "retrieve the transcriptomics projects" routes to the SAME structured path as
  // "list all transcriptomics projects" and returns the complete set (4), instead
  // of falling through to semantic search, which recalls only the 2 obvious ones.
  const enumerateVerb = /\b(list|show|give me|give|retrieve|find|fetch|get|pull|bring|what|which|display|enumerate|name|any)\b/.test(q);

  // --- group: an aggregate verb + an explicit facet keyword ---
  // Also fires when the facet noun is itself the thing being enumerated ("which
  // tools are used?", "list the diseases"), which reads as a breakdown request
  // even without an explicit aggregate verb. This does NOT catch "which projects
  // use Seurat?" — there the enumerated noun is "projects", not a facet keyword.
  const facet = detectFacet(q);
  const facetIsSubject = /\b(which|what|list|show|name|give me|display|enumerate)\s+(the\s+|all\s+the\s+|all\s+)?(tools?|packages?|software|librar\w*|diseases?|conditions?|indications?|methods?|techniques?|approach\w*|data ?types?|modalit\w*|assays?)\b/.test(q);
  if (facet && (aggregateVerb || /\bby\b|\bper\b/.test(q) || facetIsSubject) && mentionsProjects) {
    return { kind: 'group', facet };
  }

  // --- category: an enumerate/aggregate verb + exactly ONE recognised data type,
  // and NO other qualifier. Guards, all learned from adversarial testing:
  //  - Multiple types named ("proteomics and transcriptomics"): fall through, or
  //    we would silently answer for only the first and drop the rest.
  //  - A non-type qualifier survives ("which transcriptomics projects used RNA
  //    velocity"): that is a filtered semantic question, not a whole-category
  //    enumeration, so fall through. isBareTypeQuery enforces this, mirroring
  //    the bareness guard the list/total branches already use.
  const types = detectAllDataTypes(q);
  if (types.length === 1 && mentionsProjects && (enumerateVerb || aggregateVerb)
      && isBareTypeQuery(q, types[0])) {
    return { kind: 'category', facet: 'data_type', type: types[0].canonical };
  }

  // --- list: enumerate ALL projects, no facet, no qualifier ---
  // Must be a BARE "list all projects" — if any content word survives (a disease,
  // a tool, a topic: "list all leukaemia projects"), it is a filtered request,
  // not a full enumeration, so fall through to semantic search / category paths.
  const listAll = /\b(all|every|each|the full|the entire|the whole|everything)\b/.test(q)
    || /\bwhat\b.*\b(do you have|are there|exist|are stored|are in)\b/.test(q);
  if (mentionsProjects && enumerateVerb && listAll && isBareCatalogueQuery(q, LIST_WORDS)) {
    return { kind: 'list' };
  }

  // --- total: count of projects, no facet, no qualifier ---
  // Same bareness guard: "how many projects" is a total; "how many projects use
  // Seurat" / "how many leukaemia projects" are NOT (a qualifier survives), so
  // they fall through rather than wrongly answering "11".
  if (mentionsProjects && aggregateVerb && isBareCatalogueQuery(q, TOTAL_WORDS)) {
    return { kind: 'total' };
  }

  return null;
}

// A query is a BARE catalogue query when every word in it is catalogue filler
// (or one of the branch-specific verbs). If any content word survives — a
// disease, tool, organism, topic — the query is qualified and must NOT be
// answered as a whole-catalogue total/list.
const CATALOGUE_FILLER = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'are', 'is', 'be', 'there',
  'do', 'does', 'did', 'you', 'we', 'us', 'i', 'me', 'my', 'our', 'so', 'far',
  'currently', 'now', 'please', 'can', 'could', 'would', 'how', 'what', 'whats',
  "what's", 'and',
  'projects', 'project', 'studies', 'study', 'analyses', 'analysis', 'work',
  'entries', 'entry', 'catalogue', 'catalog', 'database', 'db', 'repository',
  'repo', 'dash', 'entire', 'whole', 'complete', 'full', 'have', 'has', 'contain',
  'contains', 'hold', 'holds', 'stored', 'held', 'exist', 'exists', 'listed',
  'many', 'number', 'count', 'counts', 'total',
]);
const TOTAL_WORDS = new Set([]);
const LIST_WORDS = new Set(['list', 'show', 'give', 'display', 'name', 'see', 'view',
  'retrieve', 'find', 'fetch', 'get', 'pull', 'bring',
  'all', 'every', 'each', 'everything', 'out']);

function isBareCatalogueQuery(q, extra) {
  const tokens = q.match(/[a-z0-9']+/g) || [];
  return tokens.every((t) => CATALOGUE_FILLER.has(t) || extra.has(t));
}

// True when a query is an UNQUALIFIED catalogue query (every word is filler or an
// enumerate verb). The regex router's total/list branches already enforce this;
// exported so the LLM-router guard can enforce the same on count_total/list_all
// (which the model otherwise emits for "how many MULTI-OMICS projects" -> 11).
export function isBareCatalogueText(text) {
  const allowed = new Set([...CATALOGUE_FILLER, ...LIST_WORDS, ...ENUMERATE_WORDS]);
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9']+/g) || [];
  return tokens.length > 0 && tokens.every((t) => allowed.has(t));
}

// Which explicit breakdown facet, if any, the query names. data_type is checked
// first because "data type" / "modality" is the most common ask.
function detectFacet(q) {
  if (/\bdata ?type(s)?\b|\bmodalit/.test(q)) return 'data_type';
  if (/\bassay(s)?\b|\bdata\b(?!\s*base)/.test(q) && /\b(type|kind|by)\b/.test(q)) return 'data_type';
  if (/\bdisease(s)?\b|\bcondition(s)?\b|\bindication(s)?\b/.test(q)) return 'disease';
  if (/\btool(s)?\b|\bpackage(s)?\b|\bsoftware\b|\blibrar/.test(q)) return 'tool';
  if (/\bmethod(s)?\b|\btechnique(s)?\b|\bapproach(es)?\b|\banalysis type/.test(q)) return 'method';
  return null;
}

// Every canonical data type the query names (by matching the user's words
// against each type's `query` synonyms). Returns [] when none match. Used to
// detect the multi-type case ("proteomics and transcriptomics") so it is not
// silently reduced to the first match.
function detectAllDataTypes(q) {
  return DATA_TYPES.filter((t) => t.query.some((syn) => q.includes(syn)));
}

// Enumerate/count/retrieval verbs allowed inside a bare type query.
const ENUMERATE_WORDS = new Set([
  'list', 'show', 'give', 'me', 'what', 'which', 'display', 'enumerate', 'name',
  'any', 'see', 'view', 'how', 'many',
  'retrieve', 'find', 'fetch', 'get', 'pull', 'bring',
]);
// Connector words that may legitimately appear in "list all X projects" without
// making it a qualified/filtered request.
const TYPE_CONNECTORS = new Set([
  'data', 'involving', 'involve', 'involved', 'involves', 'using', 'use', 'used',
  'uses', 'with', 'on', 'about', 'related', 'that', 'are',
]);

// A query is a bare TYPE query when every word is catalogue filler, an enumerate
// verb, a connector, or belongs to the matched type. If any other content word
// survives (another type, a tool, a method qualifier), the query is filtered and
// must go to semantic search, not category enumeration. Type membership is by
// stem (prefix) match in either direction, so the substring synonym "epigenom"
// covers the token "epigenomics" and "transcriptomic" covers "transcriptomics".
function isBareTypeQuery(q, type) {
  const allowed = new Set([...CATALOGUE_FILLER, ...ENUMERATE_WORDS, ...LIST_WORDS, ...TYPE_CONNECTORS]);
  const synWords = type.query
    .flatMap((syn) => syn.split(/[\s-]+/))
    .filter((w) => w.length >= 3);
  const belongsToType = (t) => synWords.some((w) => t.startsWith(w) || w.startsWith(t));
  const tokens = q.match(/[a-z0-9']+/g) || [];
  return tokens.every((t) => allowed.has(t) || belongsToType(t));
}

// ---------------------------------------------------------------------------
// EXECUTION (one read over ALL documents; every number comes from the DB)
// ---------------------------------------------------------------------------
// Pulls the whole catalogue once (11 small docs, no vectors) and computes every
// answer in JS. One DB round trip keeps the Durable Object hop count — and thus
// the historical 1101-crash surface — minimal, and 11 docs is trivial to scan.
//
// Returns a shape tagged by `kind` for agent.js streamAggregate to phrase:
//   total    -> { kind, total }
//   list     -> { kind, total, projects: [full docs] }
//   group    -> { kind, facet, total, buckets: [{ label, count, refs }], unclassified? }
//   category -> { kind, facet, type, label, total, projects: [full docs] }
export async function runCatalogue(intent, env) {
  const docs = await client(env).find(DB, COLL, {}, { projection: hideVector() });
  const total = docs.length;

  switch (intent.kind) {
    case 'total':
      return { kind: 'total', total };

    case 'list':
      return { kind: 'list', total, projects: sortByRef(docs) };

    case 'group':
      return { kind: 'group', facet: intent.facet, total, ...groupBy(intent.facet, docs) };

    case 'category': {
      const type = DATA_TYPES.find((t) => t.canonical === intent.type);
      const inType = (d) => projectDataTypes(d).has(intent.type);
      // `negated` gives the complement (all projects that are NOT of this type),
      // which the deterministic set makes trivial and correct — the regex router
      // refuses negation, so this path is reachable only from the LLM router.
      const projects = docs.filter((d) => (intent.negated ? !inType(d) : inType(d)));
      return {
        kind: 'category',
        facet: 'data_type',
        type: intent.type,
        label: type ? type.label : intent.type,
        negated: !!intent.negated,
        total,
        projects: sortByRef(projects),
      };
    }

    case 'count_by_value': {
      // "how many projects use Seurat / how many leukaemia projects" — an exact
      // count over a single named tool/disease/method value, which semantic
      // search cannot produce. The number is set membership computed here.
      const field = FACET_FIELD[intent.facet];
      const needle = String(intent.value || '').toLowerCase();
      const projects = (field && needle)
        ? docs.filter((d) => (getPath(d, field) || []).some((v) => {
          const s = String(v).toLowerCase();
          return s === needle || s.includes(needle) || needle.includes(s);
        }))
        : [];
      return {
        kind: 'count_by_value',
        facet: intent.facet,
        value: intent.value,
        total,
        count: projects.length,
        projects: sortByRef(projects),
      };
    }

    default:
      return { kind: 'total', total };
  }
}

// Build the buckets for a breakdown. data_type uses the canonical taxonomy;
// every other facet groups on the raw stored field (documented as granular:
// disease and method values are nearly unique per project in this catalogue,
// while tools genuinely repeat, so a tool breakdown is the most informative).
//
// Counts are DISTINCT PROJECTS per bucket. Because a project can fall in several
// buckets, the counts do not sum to `total`; callers must say so.
function groupBy(facet, docs) {
  if (facet === 'data_type') {
    const counts = new Map(DATA_TYPES.map((t) => [t.canonical, { label: t.label, refs: [] }]));
    let unclassified = 0;
    for (const d of docs) {
      const types = projectDataTypes(d);
      if (types.size === 0) { unclassified += 1; continue; }
      for (const c of types) counts.get(c).refs.push(d.ref_number);
    }
    const buckets = [...counts.values()]
      .map((b) => ({ label: b.label, count: b.refs.length, refs: b.refs.sort() }))
      .filter((b) => b.count > 0)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return { buckets, unclassified };
  }

  // Raw-field facets: unwind the array field in JS and tally distinct projects.
  const field = FACET_FIELD[facet];
  const counts = new Map();
  for (const d of docs) {
    const values = getPath(d, field);
    if (!Array.isArray(values)) continue;
    for (const v of new Set(values.map((x) => String(x)))) {
      if (!counts.has(v)) counts.set(v, []);
      counts.get(v).push(d.ref_number);
    }
  }
  const buckets = [...counts.entries()]
    .map(([label, refs]) => ({ label, count: refs.length, refs: refs.sort() }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { buckets, unclassified: 0 };
}

// The set of canonical data types a single project belongs to. Assay types are
// tested against the raw data_modality strings. Non-assay types (study_design)
// are applied ONLY as a fallback, when no assay type matched — otherwise every
// project that happens to include a power-analysis step would also be tagged
// "study design". The fallback scans research_area + primary_methods, so a
// methods-only consult with an empty data_modality (0057) still buckets.
function projectDataTypes(doc) {
  // Array.isArray, not `|| []`: a stray STRING value is truthy and would pass
  // the `|| []` guard, then crash on .map. The schema says array, but a single
  // malformed doc must not take down the whole catalogue read.
  const asArray = (v) => (Array.isArray(v) ? v : []);
  const mods = asArray(doc.project_details?.data_modality).map((m) => String(m).toLowerCase());
  const out = new Set();
  for (const t of DATA_TYPES) {
    if (t.nonAssay) continue;
    if (mods.some((m) => t.match.some((sub) => m.includes(sub)))) out.add(t.canonical);
  }
  if (out.size === 0) {
    const text = [
      ...asArray(doc.project_details?.research_area),
      ...asArray(doc.analytical_methods?.primary_methods),
    ].map((s) => String(s).toLowerCase());
    for (const t of DATA_TYPES) {
      if (!t.nonAssay) continue;
      if (text.some((s) => t.match.some((sub) => s.includes(sub)))) out.add(t.canonical);
    }
  }
  return out;
}

function sortByRef(docs) {
  return docs.slice().sort((a, b) => String(a.ref_number).localeCompare(String(b.ref_number)));
}

function getPath(obj, path) {
  return path.split('.').reduce((cur, k) => (cur == null ? cur : cur[k]), obj);
}

function hideVector() {
  return { 'embedding.vector': 0, 'embedding._source_hash': 0 };
}
