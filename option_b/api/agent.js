// agent.js — the conversational layer over retrieval, on Workers AI Llama.
//   planQuery        : extract people + a clean topical query from raw text.
//   synthesizeAnswer : write a grounded summary of the retrieved projects.
// Both degrade gracefully (deterministic fallbacks) on any error, so a flaky
// or refusing model never fails the /api/ask request.

// 8B keeps each /api/ask fast and light. The 70B model was ~2.5s/call, so two
// calls plus Mongo kept the isolate busy ~6s and tipped it into Cloudflare 1101
// crashes (surfacing as "Failed to fetch"); 8B finishes in ~0.5-1s/call.
const MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

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

const SYNTH_SYS = `You are the DASH project-catalogue assistant for a university data-science hub. Given a user's query and the projects retrieved for it, write a brief, factual answer (1-3 sentences).
Rules:
- Use ONLY the provided projects. Never invent projects, people, methods, or findings.
- Name EVERY project provided, by title (do not omit any), with the analyst/topic when useful. For a person query, give the count.
- Do NOT editorialize, praise, or speculate: no claims about anyone's expertise, skill, or impact, and nothing about biology or disease beyond what a title literally says.
- If the projects only partially match the query, say so.
- Be concise and neutral; no marketing tone.`;

function projectLine(m) {
  const parts = [`[${m.ref_number}] ${m.title}`];
  const inv = m.investigators || {};
  const people = [
    inv.lead_data_scientist,
    Array.isArray(inv.analyst_team) ? inv.analyst_team.join(', ') : inv.analyst_team,
    inv.collaborator,
  ].filter(Boolean).join('; ');
  if (people) parts.push(`people: ${people}`);
  const dis = m.project_details?.disease;
  if (Array.isArray(dis) && dis.length) parts.push(`disease: ${dis.join(', ')}`);
  const mod = m.project_details?.data_modality;
  if (Array.isArray(mod) && mod.length) parts.push(`data: ${mod.slice(0, 3).join(', ')}`);
  return parts.join(' | ');
}

// Deterministic grounding guard. Returns false if the generated answer cites a
// project ref outside the retrieved set, or quotes a multi-word span that is
// not traceable to the context we provided (or the user's query). Catches
// invented projects/titles; it does NOT catch relational misattribution
// (pairing a real analyst with the wrong real project) — that needs a judge.
export function verifyGrounded(answer, matches, query) {
  const refs = new Set(matches.map((m) => String(m.ref_number).toLowerCase()));
  // 1) Any project-ref-like token must be one of the retrieved refs.
  for (const tok of answer.match(/\bCPCDASH\d{3,4}\b|\b0\d{3}\b|\bA\d{1,2}\b/gi) || []) {
    const norm = tok.toLowerCase().replace(/^cpcdash/, '');
    if (!refs.has(norm) && !refs.has(tok.toLowerCase())) return false;
  }
  // 2) Any quoted multi-word span must appear in the grounding text.
  const grounded = (matches.map(projectLine).join(' ') + ' ' + query).toLowerCase();
  for (const m of answer.matchAll(/["“]([^"“”]{6,})["”]/g)) {
    const span = m[1].toLowerCase().trim();
    if (span.split(/\s+/).length >= 2 && !grounded.includes(span)) return false;
  }
  return true;
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
    if (typeof text === 'string' && text.trim() && verifyGrounded(text, matches, query)) {
      return text.trim();
    }
  } catch {
    /* fall through to deterministic template */
  }
  if (matches.length === 1) return `I found one relevant DASH project: "${matches[0].title}".`;
  return `I found ${matches.length} DASH projects relevant to your query; the closest is "${matches[0].title}".`;
}
