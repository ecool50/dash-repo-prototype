// Ask pipeline for POST /api/ask — the conversational agent surface.
//
// Single-pass, keyless, streamed:
//   1. planQuery (Workers AI) routes the turn: chit-chat vs a real search, and
//      extracts topic + people. Cheap (~0.5-1s); no answer round-trip.
//   2. chit-chat -> stream a warm reply (no DB hit, no cards).
//   3. otherwise -> search, emit the matched cards, then stream ONE grounded
//      answer over them.
//
// askStream(body, env, emit) drives events; the worker wraps `emit` into an
// NDJSON response body. Event types: 'matches', 'token' (the worker appends a
// trailing 'done', and 'error' on a hard failure).
//
// Request: { query, limit?, history? }, history = [{ role, text }, ...] of the
// prior turns, so a follow-up resolves against the conversation rather than
// being searched literally.

import { searchProjects } from './search.js';
import { planQuery, streamSynthesize, streamConverse, streamAggregate } from './agent.js';
import { classifyCatalogue, runCatalogue } from './catalogue.js';

export async function askStream(body, env, emit) {
  const { query, limit = 8, history = [] } = body || {};
  const clean = typeof query === 'string' ? query.trim() : '';

  if (!clean) {
    await emit({ type: 'token', text: 'Please type a question or describe what you are looking for.' });
    return;
  }

  // EXACT / catalogue-wide path (WS2). A deterministic classifier catches
  // counting, listing, by-category, and named-data-type queries BEFORE the
  // planner or any embedding runs, and answers them from a direct read over all
  // documents (catalogue.js). This is what makes "how many projects by data
  // type" return real DB numbers instead of an invented count. Only exact-typed
  // queries are intercepted; everything else falls through to semantic search.
  const cat = classifyCatalogue(clean);
  if (cat) {
    const result = await runCatalogue(cat, env);
    // 'list' and 'category' return concrete project docs -> show them as cards,
    // exactly like a search result. 'total' and 'group' have no per-project
    // result set (the answer is the count itself), so no cards are emitted and
    // the UI keeps whatever cards were already shown.
    if (result.projects) {
      await emit({ type: 'matches', matches: result.projects, searched: true });
    }
    await streamAggregate(result, env, emit);
    return;
  }

  const plan = await planQuery(clean, env, history);

  // Conversational, non-search input: stream a warm reply, no cards, no DB hit.
  // (searched stays implicit-false — no 'matches' event — so the UI keeps the
  // current cards.)
  if (plan.intent === 'chitchat' && !plan.people.length && !(plan.topic && plan.topic.trim())) {
    await streamConverse(clean, env, emit, history);
    return;
  }

  const topic = plan.topic && plan.topic.trim()
    ? plan.topic.trim()
    : (plan.people.length ? '' : clean);

  // `raw` carries the user's own words through to the structured tool lookup,
  // which the planner's topic rewrite would otherwise strip the tool name out of.
  const searchResult = await searchProjects({ query: topic, limit, people: plan.people, raw: clean }, env);
  const matches = searchResult.results || [];

  // Cards appear as soon as the search returns, before the answer streams.
  await emit({ type: 'matches', matches, searched: true });
  await streamSynthesize(
    clean,
    matches,
    env,
    { weak: !!searchResult.weak, history, toolHits: searchResult.toolHits },
    emit,
  );
}
