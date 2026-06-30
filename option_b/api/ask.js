// Ask pipeline for POST /api/ask — the conversational agent surface.
//
// Flow: planQuery (LLM extracts people + a clean topical query) -> searchProjects
// (semantic + reranker, plus structured investigator match on the planned
// people) -> synthesizeAnswer (LLM writes a grounded summary). Each LLM step
// falls back gracefully so the request never fails on a flaky/refusing model.
//
// Returns { answer: string, matches: [project_document_with_score, ...] }.

import { searchProjects } from './search.js';
import { planQuery, synthesizeAnswer } from './agent.js';

export async function askAgent(body, env) {
  const { query, limit = 5 } = body || {};

  if (!query || typeof query !== 'string' || !query.trim()) {
    return {
      answer: 'Please type a question or describe what you are looking for.',
      matches: [],
    };
  }

  const trimmed = query.trim();
  const plan = await planQuery(trimmed, env);

  // Planned topic drives semantic search; planned people drive the investigator
  // match. For a pure-person query the topic is empty (skip semantic); if the
  // planner gave us neither, fall back to searching the raw query.
  const topic = plan.topic && plan.topic.trim()
    ? plan.topic.trim()
    : (plan.people.length ? '' : trimmed);

  const searchResult = await searchProjects({ query: topic, limit, people: plan.people }, env);
  const matches = searchResult.results || [];
  const answer = await synthesizeAnswer(trimmed, matches, env);

  return { answer, matches };
}
