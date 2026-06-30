// agent.js — the conversational layer over retrieval, on Workers AI Llama.
//   planQuery        : extract people + a clean topical query from raw text.
//   synthesizeAnswer : write a grounded summary of the retrieved projects.
// Both degrade gracefully (deterministic fallbacks) on any error, so a flaky
// or refusing model never fails the /api/ask request.

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string' },
    people: { type: 'array', items: { type: 'string' } },
    intent: { type: 'string' },
  },
  required: ['topic', 'people', 'intent'],
};

const PLANNER_SYS = `You parse a researcher's search query for a biomedical data-science project catalogue. Return JSON with:
- people: person NAMES the query asks about (an analyst, collaborator, or investigator), as written (given name, surname, or full name). [] if none.
- topic: the scientific/topical part as a clean search phrase, with person names and filler ("show me", "I am looking for", "find", "projects that ... worked on") removed. When the query uses a general disease/category term, append the obvious specific synonyms to improve matching (e.g. "inflammatory skin condition" -> "inflammatory skin condition atopic dermatitis eczema"; "metabolic disease" -> "metabolic disease obesity diabetes"). Empty string if the query is ONLY about a person.
- intent: "person", "topic", or "mixed".`;

export async function planQuery(query, env) {
  const fallback = { topic: query, people: [], intent: 'topic' };
  try {
    const r = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: PLANNER_SYS },
        { role: 'user', content: query },
      ],
      response_format: { type: 'json_schema', json_schema: PLAN_SCHEMA },
      temperature: 0,
    });
    const p = r?.response;
    if (!p || typeof p !== 'object') return fallback;
    return {
      topic: typeof p.topic === 'string' ? p.topic : query,
      people: Array.isArray(p.people) ? p.people.filter((x) => typeof x === 'string' && x.trim()) : [],
      intent: typeof p.intent === 'string' ? p.intent : 'topic',
    };
  } catch {
    return fallback;
  }
}

const SYNTH_SYS = `You are the DASH project-catalogue assistant for a university data-science hub. Given a user's query and the projects retrieved for it, write a concise, helpful answer of 2-3 sentences.
Rules:
- Use ONLY the provided projects. Never invent projects, people, methods, or findings.
- Refer to projects by their title (and the analyst when relevant). Summarise; do not just list everything mechanically.
- If the projects only partially match the query, say so honestly.`;

function projectLine(m) {
  const parts = [`[${m.ref_number}] ${m.title}`];
  const inv = m.investigators || {};
  const lead = inv.lead_data_scientist
    || (Array.isArray(inv.analyst_team) ? inv.analyst_team[0] : inv.analyst_team);
  if (lead) parts.push(`analyst: ${lead}`);
  const dis = m.project_details?.disease;
  if (Array.isArray(dis) && dis.length) parts.push(`disease: ${dis.join(', ')}`);
  const mod = m.project_details?.data_modality;
  if (Array.isArray(mod) && mod.length) parts.push(`data: ${mod.slice(0, 3).join(', ')}`);
  return parts.join(' | ');
}

export async function synthesizeAnswer(query, matches, env) {
  if (!matches || matches.length === 0) {
    return `I could not find any past DASH projects that match "${query}". Try rephrasing or broadening the question.`;
  }
  try {
    const context = matches.map(projectLine).join('\n');
    const r = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: SYNTH_SYS },
        { role: 'user', content: `Query: ${query}\n\nRetrieved projects:\n${context}` },
      ],
      temperature: 0.2,
      max_tokens: 220,
    });
    const text = r?.response;
    if (typeof text === 'string' && text.trim()) return text.trim();
  } catch {
    /* fall through to deterministic template */
  }
  if (matches.length === 1) return `I found one relevant DASH project: "${matches[0].title}".`;
  return `I found ${matches.length} DASH projects relevant to your query; the closest is "${matches[0].title}".`;
}
