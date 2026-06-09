// Ask pipeline for POST /api/ask.
//
// Frontend-facing endpoint. Wraps the search pipeline and returns the
// response shape the dash-frontend SPA expects:
//   { answer: string, matches: [project_document_with_score, ...] }
//
// The `answer` is a short templated string that frames the search results
// in agent-style prose. For the mockup we keep this deterministic; swap
// in env.AI.run with a small LLM model later if you want richer answers.

import { searchProjects } from './search.js';

export async function askAgent(body, env) {
  const { query, limit = 5 } = body || {};

  if (!query || typeof query !== 'string' || !query.trim()) {
    return {
      answer: 'Please type a question or describe what you are looking for.',
      matches: [],
    };
  }

  const trimmed = query.trim();
  const searchResult = await searchProjects({ query: trimmed, limit }, env);
  const matches = searchResult.results || [];

  let answer;
  if (matches.length === 0) {
    answer = `I could not find any past DASH projects that match "${trimmed}". Try rephrasing or broadening the question.`;
  } else if (matches.length === 1) {
    answer = `I found one DASH project that looks relevant: "${matches[0].title}". Open the details to see the methods and findings.`;
  } else {
    answer = `I found ${matches.length} DASH projects related to "${trimmed}". The closest match is "${matches[0].title}"; the rest are ordered by similarity.`;
  }

  return { answer, matches };
}
