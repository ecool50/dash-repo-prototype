// Router / cascade regression corpus. The single source of truth for what the
// agent must route correctly. EVERY production misroute we have found is locked
// in here as a case (marked `bug`). Two runners consume it:
//   offline.mjs  — deterministic pre-deploy gate (classifier, guard invariants,
//                  executor math). No network, no model. MUST be green to ship.
//   live.mjs     — post-deploy check against the deployed Worker (router quality
//                  + full cascade behaviour).
//
// Per case (all fields optional except name + queries):
//   queries    : phrasings that must all behave the SAME (paraphrase consistency)
//   regex      : expected regexIntent(classifyCatalogue(q)).intent, or null if
//                the regex should miss and defer to the LLM router. (offline)
//   guard      : { from, expect } — feed a MOCK router intent `from` through
//                guardIntent(from,q); the result's fields must match `expect`.
//                This is how we lock a guard invariant deterministically. (offline)
//   route      : expected LLM intent from /api/route (fields checked loosely). (live)
//   ask        : expected /api/ask behaviour — { cards, cardsMin, contains[],
//                notContains[], containsAny[] }. (live)
//   bug        : true if this case is a locked regression of a real misroute.
//   knownGap   : true if currently expected to fail (reported, does NOT gate).

export const CASES = [
  // --- core exact intents (regex fast-path) ---
  { name: 'total', queries: ['how many projects are there', 'how many projects do you have in total', 'total number of studies'],
    regex: 'count_total', ask: { cards: 0, contains: ['11 projects'] } },

  { name: 'list-all', queries: ['list all projects', 'show me every project'],
    regex: 'list_all', ask: { cards: 11, contains: ['all 11'] } },

  { name: 'breakdown-datatype', queries: ['summarise the projects by data type', 'break down the catalogue by data type'],
    regex: 'breakdown', ask: { cards: 0, contains: ['By data type', 'Transcriptomics (4)', 'do not sum to 11'] } },

  { name: 'breakdown-tool', queries: ['which tools are used across projects', 'count projects by tool'],
    regex: 'breakdown', ask: { cards: 0, contains: ['edgeR (4)'] } },

  // --- category, incl. the retrieve-vs-list consistency bug ---
  { name: 'category-transcriptomics', bug: true,
    queries: ['list all transcriptomics projects', 'retrieve the transcriptomics projects', 'find transcriptomics projects', 'get me the transcriptomics projects'],
    regex: 'category', ask: { cards: 4, contains: ['4 of the 11'] } },

  { name: 'category-rnaseq-router', bug: true, queries: ["what've you got on RNA-seq", 'show me the single-cell RNA work'],
    regex: null, route: { intent: 'category', data_type: 'transcriptomics' }, ask: { cards: 4, contains: ['transcriptomics'] } },

  // --- count_by_value ---
  { name: 'count-tool-seurat', queries: ['how many projects use Seurat', 'count the Seurat projects'],
    regex: null, route: { intent: 'count_by_value', facet: 'tool', value: 'seurat' }, ask: { cards: 2, contains: ['Seurat'] } },

  { name: 'count-disease-leukaemia', queries: ['how many leukaemia projects are there'],
    regex: null, route: { intent: 'count_by_value', facet: 'disease' }, ask: { cards: 1, contains: ['leukaemia'] } },

  // --- negation (guard recovers data_type the 8B omits) ---
  { name: 'negated-transcriptomics', bug: true, queries: ['projects that are not transcriptomics'],
    regex: null,
    guard: { from: { intent: 'category', data_type: '', negated: true }, expect: { intent: 'category', data_type: 'transcriptomics', negated: true } },
    ask: { cards: 7, contains: ['do NOT involve'] } },
  { name: 'negated-proteomics', bug: true, queries: ['which projects are not proteomics'],
    regex: null,
    guard: { from: { intent: 'category', data_type: '', negated: true }, expect: { intent: 'category', data_type: 'proteomics', negated: true } },
    ask: { cards: 9, contains: ['do NOT involve'] } },

  // --- guard: breakdown needs a grouping cue (the "sample size" misroute) ---
  { name: 'sample-size-not-breakdown', bug: true,
    queries: ['are there any projects on sample size calculations?', 'do you have any sample size work'],
    guard: { from: { intent: 'breakdown', facet: 'method' }, expect: { intent: 'semantic' } },
    ask: { notContains: ['By analytical method', 'By data type'], containsAny: ['Sample Size Determination', 'sample size'] } },

  // --- guard: a data type not present in the query is distrusted ---
  { name: 'diabetes-not-clinical-category', bug: true, queries: ['how many projects on diabetes'],
    guard: { from: { intent: 'category', data_type: 'clinical_meta' }, expect: { intent: 'semantic' } },
    ask: { notContains: ['By '] } },

  // --- guard: a qualified count/list is not a whole-catalogue answer ---
  { name: 'multi-omics-not-total', bug: true, queries: ['how many multi-omics projects', 'how many single-cell spatial projects'],
    guard: { from: { intent: 'count_total' }, expect: { intent: 'semantic' } },
    ask: { notContains: ['There are 11 projects'] } },

  // --- guard: category + a hard tool constraint -> semantic (don't drop it) ---
  // The guard is deterministic and locked. No `ask` assertion: end-to-end depends
  // on the 8B SIGNALLING the tool in `value`, which it does inconsistently — when
  // it silently drops "Seurat" the cascade still returns the whole type. Fully
  // closing this needs deterministic tool detection in the guard (a follow-up).
  { name: 'category-tool-constraint', bug: true, queries: ['transcriptomics projects using Seurat'],
    guard: { from: { intent: 'category', data_type: 'transcriptomics', value: 'Seurat' }, expect: { intent: 'semantic' } } },

  // --- guard: deterministic negation (the 8B drops "isn't") ---
  { name: 'negation-contraction', bug: true, queries: ["anything that isn't imaging", 'projects without RNA-seq'],
    guard: { from: { intent: 'category', data_type: 'imaging', negated: false }, expect: { intent: 'category', data_type: 'imaging', negated: true } },
    ask: { contains: ['do NOT involve'], cardsMin: 6 } },

  // --- semantic / person ---
  { name: 'person-by-name', queries: ['projects by Jean Yang', 'work led by Ellis Patrick'],
    regex: null, route: { intent: 'person' } },

  { name: 'who-worked-on-disease', bug: true, knownGap: true, queries: ['who worked on the leukaemia project'],
    regex: null, route: { intent: 'semantic' }, ask: { cardsMin: 1 } },

  { name: 'chitchat', queries: ['hi there, what can you do', 'thanks for the help', 'who are you'],
    regex: null, route: { intent: 'chitchat' }, ask: { cards: 0 } },

  // --- executor math (checked offline against the fixture) ---
  { name: 'exec-count-seurat', exec: { kind: 'count_by_value', facet: 'tool', value: 'Seurat', count: 2 } },
  { name: 'exec-count-edger', exec: { kind: 'count_by_value', facet: 'tool', value: 'edgeR', count: 4 } },
  { name: 'exec-category-transcriptomics', exec: { kind: 'category', type: 'transcriptomics', count: 4 } },
  { name: 'exec-category-transcriptomics-neg', exec: { kind: 'category', type: 'transcriptomics', negated: true, count: 7 } },
  { name: 'exec-category-proteomics', exec: { kind: 'category', type: 'proteomics', count: 2 } },
  { name: 'exec-total', exec: { kind: 'total', count: 11 } },
];
