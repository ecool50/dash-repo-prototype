// Ask pipeline for POST /api/ask — the conversational agent surface.
//
// Primary path: a tool-using agent (agent-loop.js, Gemini function calling)
// that decides each turn whether to search, fetch a project, or just reply —
// so follow-ups and chit-chat don't hit the database.
//
// Fallback path (no GEMINI_API_KEY, or the agent loop errors/aborts): the
// deterministic plan -> search -> synth pipeline below, which always works and
// is keyless. Every LLM step there also degrades gracefully.
//
// Request:  { query, limit?, history? }   history = [{ role, text }, ...]
// Response: { answer, matches, searched }  searched=false on chat/context turns
//           so the frontend keeps the current cards instead of clearing them.

import { searchProjects } from './search.js';
import { planQuery, synthesizeAnswer, converseAnswer } from './agent.js';
import { agentLoop } from './agent-loop.js';

export async function askAgent(body, env) {
  const { query, limit = 5, history = [] } = body || {};

  if (!query || typeof query !== 'string' || !query.trim()) {
    return {
      answer: 'Please type a question or describe what you are looking for.',
      matches: [],
      searched: false,
    };
  }

  const trimmed = query.trim();

  // Primary: the tool-using agent. Returns null on any failure so we fall back.
  if (env.GEMINI_API_KEY) {
    try {
      const result = await agentLoop(trimmed, history, env);
      if (result) return result;
    } catch {
      /* fall through to the deterministic pipeline */
    }
  }

  return pipelineAnswer(trimmed, env, limit);
}

// Deterministic plan -> search -> synth pipeline. Single-turn (no history);
// used when Gemini is unavailable or the agent loop bails.
async function pipelineAnswer(trimmed, env, limit) {
  const plan = await planQuery(trimmed, env);

  // Conversational, non-search input: reply warmly, no cards, no DB hit.
  if (plan.intent === 'chitchat' && !plan.people.length && !(plan.topic && plan.topic.trim())) {
    return { answer: await converseAnswer(trimmed, env), matches: [], searched: false };
  }

  const topic = plan.topic && plan.topic.trim()
    ? plan.topic.trim()
    : (plan.people.length ? '' : trimmed);

  const searchResult = await searchProjects({ query: topic, limit, people: plan.people }, env);
  const matches = searchResult.results || [];
  const answer = await synthesizeAnswer(trimmed, matches, env, { weak: !!searchResult.weak });

  return { answer, matches, searched: true };
}
