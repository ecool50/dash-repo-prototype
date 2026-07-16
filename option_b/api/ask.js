// Ask pipeline for POST /api/ask — the conversational agent surface.
//
// ROUTE / EXECUTE split (WS1): a router decides the INTENT, deterministic
// executors produce every answer. The router never counts or lists, so a
// fabricated number is impossible. Cascade:
//   1. classifyCatalogue (regex, instant) — the fast path for the clear cases.
//   2. on a regex miss, the LLM router (router.js, keyless Workers AI) — the
//      phrasing tail ("retrieve the transcriptomics projects").
//   3. its output passes a deterministic cross-check (guardIntent) before use.
//   4. still nothing? the legacy Workers AI planner splits chitchat vs search.
// Every branch dispatches to an executor: runCatalogue (exact counts/lists),
// categoryRanked (filter-then-semantic-rank), or searchProjects + grounded
// synthesis. If the router errors, we degrade to the planner path, never below
// today's behaviour.
//
// askStream(body, env, emit) drives NDJSON events: 'matches', 'token' (+ the
// worker appends 'done'/'error'). Request: { query, limit?, history? }.

import { searchProjects, categoryRanked } from './search.js';
import { planQuery, streamSynthesize, streamConverse, streamAggregate } from './agent.js';
import { classifyCatalogue, runCatalogue, dataTypesInText, isBareCatalogueText } from './catalogue.js';

// A negation cue anywhere in the query. Used to force `negated` on a category
// intent deterministically, since the 8B router drops it on phrasings like
// "anything that isn't imaging".
const NEGATION_RE = /\bnot\b|n't\b|\bwithout\b|\bexclud|\bexcept\b|\bnon-|\bother than\b/;
import { routeIntent, hasRouter } from './router.js';

export async function askStream(body, env, emit) {
  const { query, limit = 8, history = [] } = body || {};
  const clean = typeof query === 'string' ? query.trim() : '';

  if (!clean) {
    await emit({ type: 'token', text: 'Please type a question or describe what you are looking for.' });
    return;
  }

  // 1. Regex fast path (trusted, instant).
  let intent = regexIntent(classifyCatalogue(clean));

  // 2. LLM router only on a regex miss, cross-checked before use.
  if (!intent && hasRouter(env)) {
    try { intent = guardIntent(await routeIntent(clean, history, env), clean); }
    catch { intent = null; }
  }

  // 3. Still nothing (no key, router failed, or a genuinely fuzzy query): use the
  // legacy planner to separate chitchat from a topical/person search.
  if (!intent) {
    const plan = await planQuery(clean, env, history);
    intent = (plan.intent === 'chitchat' && !plan.people.length && !(plan.topic || '').trim())
      ? { intent: 'chitchat' }
      : { intent: 'semantic', topic: plan.topic, people: plan.people };
  }

  await dispatch(intent, clean, history, limit, env, emit);
}

// Map the regex classifier's {kind} onto the unified intent shape the dispatcher
// consumes. Returns null when the regex did not match (fall through to the LLM).
// Exported for the offline eval gate.
export function regexIntent(cat) {
  if (!cat) return null;
  switch (cat.kind) {
    case 'total': return { intent: 'count_total' };
    case 'list': return { intent: 'list_all' };
    case 'group': return { intent: 'breakdown', facet: cat.facet };
    case 'category': return { intent: 'category', data_type: cat.type, qualifiers: [], negated: false };
    default: return null;
  }
}

// Deterministic cross-check on the LLM router's output: if it claims a structured
// intent whose key parameter is not actually supported by the query text, we
// distrust it and downgrade to semantic search (the safe default that never
// returns a wrong authoritative count). This is what stops a router mis-route
// ("how many projects on diabetes" -> category/clinical_meta) from surfacing.
// Exported for the offline eval gate (the guard-invariant tests).
export function guardIntent(intent, clean) {
  if (!intent) return null;
  const toSemantic = () => ({ intent: 'semantic', topic: clean, people: intent.people || [] });
  switch (intent.intent) {
    // A whole-catalogue count/list must be UNQUALIFIED. "how many multi-omics
    // projects" is not a total; without this the model's count_total returns 11.
    case 'count_total':
    case 'list_all':
      return isBareCatalogueText(clean) ? intent : toSemantic();

    case 'category': {
      // A hard constraint the type executor cannot intersect (a specific TOOL in
      // `value`, or a person) makes this a FILTERED query -> semantic. But only
      // when `value` is a genuine other constraint: the 8B often just RESTATES
      // the data type in `value` ("not transcriptomics" -> value:"transcriptomics"),
      // which is redundant, not a filter, and must NOT trigger a downgrade.
      const valueIsAType = intent.value && dataTypesInText(intent.value).length > 0;
      if ((intent.value && !valueIsAType) || (intent.people && intent.people.length)) return toSemantic();
      // Negation is detected deterministically here — the 8B drops it on some
      // phrasings ("anything that isn't imaging"), so the query text decides.
      const negated = !!intent.negated || NEGATION_RE.test(clean.toLowerCase());
      // The named data type must appear in the query; recover it when the router
      // left it empty and exactly one type is named (happens on negated queries).
      const inText = dataTypesInText(clean);
      if (intent.data_type) {
        return inText.includes(intent.data_type) ? { ...intent, negated } : toSemantic();
      }
      return inText.length === 1 ? { ...intent, data_type: inText[0], negated } : toSemantic();
    }
    case 'count_by_value':
      if (!intent.value || !['tool', 'disease', 'method'].includes(intent.facet)) return toSemantic();
      return intent;
    case 'breakdown':
      if (!['data_type', 'disease', 'tool', 'method'].includes(intent.facet)) return toSemantic();
      // A breakdown must actually be a grouping request. Without a grouping cue
      // ("by", "distribution", "summarise", ...) the model over-triggered it —
      // e.g. "are there any projects on sample size calculations?" is a search,
      // not a by-method tally. Downgrade to semantic so the real project surfaces.
      if (!/\b(by|per|grouped|group|breakdown|break down|distribution|summar|across|split|tally)\b/.test(clean.toLowerCase())) {
        return toSemantic();
      }
      return intent;
    case 'person':
      if (!intent.people || !intent.people.length) return toSemantic();
      return intent;
    default:
      return intent;
  }
}

async function dispatch(intent, clean, history, limit, env, emit) {
  switch (intent.intent) {
    case 'chitchat':
      return streamConverse(clean, env, emit, history);

    case 'count_total':
      return runAndAggregate({ kind: 'total' }, env, emit);
    case 'list_all':
      return runAndAggregate({ kind: 'list' }, env, emit);
    case 'breakdown':
      return runAndAggregate({ kind: 'group', facet: intent.facet }, env, emit);
    case 'count_by_value':
      return runAndAggregate({ kind: 'count_by_value', facet: intent.facet, value: intent.value }, env, emit);

    case 'category': {
      // Qualified ("transcriptomics work on atopic dermatitis"): keep the whole
      // typed set (complete), order it by the qualifier, and let the grounded
      // synthesis describe the match. Bare: the exact catalogue answer.
      if (Array.isArray(intent.qualifiers) && intent.qualifiers.length) {
        const { results } = await categoryRanked({ type: intent.data_type, qualifiers: intent.qualifiers, limit }, env);
        await emit({ type: 'matches', matches: results, searched: true });
        return streamSynthesize(clean, results, env, { history }, emit);
      }
      return runAndAggregate({ kind: 'category', type: intent.data_type, negated: intent.negated }, env, emit);
    }

    case 'person':
    case 'semantic':
    default:
      return runSemantic(intent, clean, history, limit, env, emit);
  }
}

// Exact-answer executors: run the DB computation, show any project cards, then
// stream the deterministic grounded phrasing.
async function runAndAggregate(kindIntent, env, emit) {
  const result = await runCatalogue(kindIntent, env);
  if (result.projects) await emit({ type: 'matches', matches: result.projects, searched: true });
  await streamAggregate(result, env, emit);
}

// Semantic / person search, driven by the intent's topic + people (from either
// the LLM router or the legacy planner). Cards, then grounded synthesis.
async function runSemantic(intent, clean, history, limit, env, emit) {
  const topic = (intent.topic && intent.topic.trim())
    ? intent.topic.trim()
    : ((intent.people && intent.people.length) ? '' : clean);
  const searchResult = await searchProjects({ query: topic, limit, people: intent.people || [], raw: clean }, env);
  const matches = searchResult.results || [];
  await emit({ type: 'matches', matches, searched: true });
  await streamSynthesize(
    clean, matches, env,
    { weak: !!searchResult.weak, history, toolHits: searchResult.toolHits },
    emit,
  );
}
