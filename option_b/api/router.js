// router.js — the LLM intent ROUTER (WS1), on keyless Cloudflare Workers AI.
// The model classifies the query into a structured intent; deterministic code
// (ask.js dispatcher + catalogue.js / search.js executors) produces every
// answer. The router NEVER counts, lists, or answers: its output schema has no
// count/list/answer field, so a fabricated number is structurally impossible
// here, exactly as in WS2.
//
// Why Workers AI, not Gemini: routing is an easy, constrained-output
// classification task, so a free Workers AI model handles it — and it stays
// keyless (no external vendor, project text never leaves for a third party) and
// has no per-minute rate-limit cliff. Gemini remains a one-line swap if a paid
// key is ever provisioned.
//
// Cascade (see ask.js): the deterministic regex `classifyCatalogue` runs FIRST
// as a fast path (instant, no model). This router is called only when the regex
// returns null — the phrasing tail it cannot catch ("retrieve the transcriptomics
// projects", "what've you got on RNA-seq"). If the model errors, ask.js falls
// back to today's semantic path, so the system never regresses.

import { CANONICAL_DATA_TYPES } from './catalogue.js';

// 8B-fast: routing is an easy, enum-constrained classification task, so the fast
// small model handles it — and it must, on latency. The 70B model routed
// correctly too but ran ~6s warm / ~57s cold on Workers AI, unusable even on the
// tail. Override via env.ROUTER_MODEL to trial a larger model if the eval shows
// 8B mis-routing tricky paraphrases.
const MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

const INTENTS = ['count_total', 'list_all', 'summarise', 'breakdown', 'category',
  'count_by_value', 'semantic', 'person', 'chitchat'];
const FACETS = ['data_type', 'disease', 'tool', 'method'];

// Workers AI takes a standard JSON schema (lowercase types) in response_format.
// data_type is enum-locked to the canonical taxonomy (imported — one source of
// truth), so the model maps surface terms (RNA-seq, Xenium, scRNA) onto a
// canonical value by meaning, which fixes the substring-recall gap.
function intentSchema() {
  return {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: INTENTS },
      data_type: { type: 'string', enum: [...CANONICAL_DATA_TYPES, 'none'] },
      facet: { type: 'string', enum: [...FACETS, 'none'] },
      value: { type: 'string' },
      qualifiers: { type: 'array', items: { type: 'string' } },
      negated: { type: 'boolean' },
      people: { type: 'array', items: { type: 'string' } },
      topic: { type: 'string' },
    },
    required: ['intent', 'data_type', 'facet', 'value', 'qualifiers', 'negated', 'people', 'topic'],
  };
}

const SYS = `You are the intent ROUTER for a search assistant over a catalogue of past biomedical data-science projects. Classify the query into ONE intent and extract parameters. Output JSON only, matching the schema. You NEVER answer, count, or list projects yourself — you only classify.

A DATA TYPE is one of: transcriptomics, proteomics, epigenomics, imaging, spatial, clinical_meta, wearable_sensor, study_design. Map surface terms by MEANING: RNA-seq / single-cell RNA / scRNA / gene expression -> transcriptomics; mass spec / DIA / proteomic -> proteomics; CUT&RUN / histone / ChIP / chromatin -> epigenomics; imaging mass cytometry / multiplexed imaging -> imaging; spatial / spatially-resolved / Xenium / spatial transcriptomics / spatial proteomics -> spatial; systematic review / survival / clinical outcomes -> clinical_meta; wearable / accelerometer / sensor -> wearable_sensor; sample size / power analysis / biostatistics / study design -> study_design. A query about "spatial" maps to spatial (not transcriptomics/proteomics). A DISEASE (leukaemia, diabetes, cancer, heart failure, ...) is NOT a data type. A TOOL (Seurat, edgeR, limma, ...) is NOT a data type.

Intents:
- count_total: how many projects there are IN TOTAL, with NO type/tool/disease/topic ("how many projects", "what's in the catalogue", "total number of studies").
- list_all: enumerate EVERY project, with NO type/tool/disease/topic filter ("list all projects", "show me every project", "what projects do you have"). If a specific data type IS named, use category, not list_all.
- summarise: a request to SUMMARISE / describe / give an overview of / "tell me about" the projects or the catalogue as a whole, including a follow-up pronoun ("summarise them", "tell me about those", "give me an overview", "what's in the catalogue about") when the conversation was about the projects. Whole-catalogue only — if a specific data type is named, use category.
- breakdown: grouped counts ACROSS all values of a facet — triggered by "by X", "grouped by", "distribution of", "which tools/diseases/methods are used". Set facet: data_type (also for "modality"), disease, tool, or method. Do NOT set data_type/value for breakdown.
- category: the projects OF a named data type, in ANY phrasing — list/retrieve/find/show/get/pull/"list all"/"what've you got on". Set data_type. Leave value empty.
- count_by_value: the user asks HOW MANY / the COUNT of projects for ONE specific tool, disease, or method ("how many projects use Seurat", "how many leukaemia projects", "how many projects on diabetes"). Set facet (tool|disease|method) and value=the specific name. This is different from breakdown (breakdown = counts for EVERY value; count_by_value = count for ONE named value).
- person: search by an investigator/analyst NAME the user gives, including "by X", "led by X", "run by X" ("projects by Jean Yang", "work led by Ellis Patrick"). Set people=[the name].
- semantic: a fuzzy topical search that is not one of the above. INCLUDES "WHO worked on / who ran / who led <a project described by topic or disease>" (no name given, so find the project topically). If the query names a data type AND an extra constraint ("transcriptomics work ON atopic dermatitis"), use category with data_type AND put the constraint in qualifiers.
- chitchat: greeting, thanks, or a question about you/the assistant.

Rules:
- "who / which analyst / who led / who ran / who worked on <a topic or disease, not a name>" -> semantic. "led by / run by / by <a NAME>" -> person.
- Set negated=true for complements ("projects that are NOT transcriptomics", "excluding proteomics").
- value is ONLY for count_by_value (the specific tool/disease/method name). Leave value "" for every other intent.
- Put residual constraints (a disease, a method, a topic beyond the data type) in qualifiers.
- topic = a clean semantic search phrase for semantic/person intents; "" otherwise.
- Use ONLY the allowed enum values for data_type and facet; "none" when not applicable.`;

export function hasRouter(env) {
  return !!(env && env.AI);
}

// Build the Workers AI messages: system prompt, a little history for follow-ups,
// then the current turn. History is advisory context for the classifier only.
function toMessages(text, history) {
  const turns = (Array.isArray(history) ? history : [])
    .slice(-4)
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({
      role: m.role === 'assistant' || m.role === 'agent' ? 'assistant' : 'user',
      content: m.text.trim().slice(0, 300),
    }));
  return [{ role: 'system', content: SYS }, ...turns, { role: 'user', content: text }];
}

async function callOnce(text, history, env) {
  const r = await env.AI.run(env.ROUTER_MODEL || MODEL, {
    messages: toMessages(text, history),
    response_format: { type: 'json_schema', json_schema: intentSchema() },
    temperature: 0,
  });
  let p = r?.response;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
  if (!p || typeof p !== 'object') throw new Error('router: no structured response');
  return normalizeIntent(p);
}

// Classify one turn. One retry on any transient model error; then throws so the
// caller falls back fast. Returns the intent object.
export async function routeIntent(text, history, env) {
  try {
    return await callOnce(text, history, env);
  } catch {
    return await callOnce(text, history, env);
  }
}

// Validate + coerce. Workers AI does not enforce enums as hard as Gemini's
// constrained decoding, so we validate every enum here: an out-of-set intent
// becomes 'semantic' (the safe default), and an out-of-taxonomy data_type/facet
// becomes '' (none). This is the guarantee that a model slip cannot inject a
// type or facet the executor doesn't understand.
function normalizeIntent(p) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
  const str = (v) => (typeof v === 'string' ? v : '');
  const dt = str(p.data_type);
  const fc = str(p.facet);
  return {
    intent: INTENTS.includes(p.intent) ? p.intent : 'semantic',
    data_type: CANONICAL_DATA_TYPES.includes(dt) ? dt : '',
    facet: FACETS.includes(fc) ? fc : '',
    value: str(p.value) === 'none' ? '' : str(p.value),
    qualifiers: arr(p.qualifiers),
    negated: !!p.negated,
    people: arr(p.people),
    topic: str(p.topic) === 'none' ? '' : str(p.topic),
  };
}
