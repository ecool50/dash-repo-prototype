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
import { planQuery, streamSynthesize, streamConverse } from './agent.js';

export async function askStream(body, env, emit) {
  const { query, limit = 8, history = [] } = body || {};
  const clean = typeof query === 'string' ? query.trim() : '';

  if (!clean) {
    await emit({ type: 'token', text: 'Please type a question or describe what you are looking for.' });
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

  const searchResult = await searchProjects({ query: topic, limit, people: plan.people }, env);
  const matches = searchResult.results || [];

  // Cards appear as soon as the search returns, before the answer streams.
  await emit({ type: 'matches', matches, searched: true });
  await streamSynthesize(clean, matches, env, { weak: !!searchResult.weak, history }, emit);
}
