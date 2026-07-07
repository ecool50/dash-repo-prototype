// agent.js — the conversational layer over retrieval.
//   planQuery        : extract people + a clean topical query from raw text
//                      (Workers AI Llama; fast, keyless, structured JSON).
//   synthesizeAnswer : write a grounded, conversational summary of the
//                      retrieved projects. Uses Gemini when GEMINI_API_KEY is
//                      set; otherwise the Workers AI Llama path below. Either
//                      way it degrades to a deterministic template on error,
//                      so a flaky or refusing model never fails /api/ask.

// 8B keeps each /api/ask fast and light. The 70B model was ~2.5s/call, so two
// calls plus Mongo kept the isolate busy ~6s and tipped it into Cloudflare 1101
// crashes (surfacing as "Failed to fetch"); 8B finishes in ~0.5-1s/call.
// Gemini synthesis runs off-isolate (external fetch), so it doesn't add to the
// isolate-CPU budget that motivated the 8B downgrade, but it does add network
// latency and a new failure mode — hence the guarded fallback chain below.
const MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

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
- intent: "person" (only people named), "topic" (a scientific/topical project search), "mixed" (both), or "chitchat" (a greeting, thanks, small talk, or a question about you/the assistant — NOT a request to find projects; for chitchat, people is [] and topic is "").`;

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

// Conversational synthesis prompt for Gemini. Warmer and more assistant-like
// than SYNTH_SYS, but bound by the same grounding rules so verifyGrounded stays
// satisfiable: it may only draw on the fields provided per project.
const GEMINI_SYNTH_SYS = `You are the DASH search assistant for the Charles Perkins Centre Data Science Hub at the University of Sydney. You help researchers find relevant past data-science projects. Speak like a helpful, knowledgeable colleague pointing someone to prior work.

You are given the user's query and the projects retrieved for it. Each project lists only: reference number, title, people, disease, and data modality.

Rules:
- Use ONLY the fields provided for each project. Never invent projects, people, methods, findings, or any detail not listed. Do not describe biology or disease beyond what a title literally says.
- Name every retrieved project by its title, leading with the best match and drawing out why it fits the query (disease area, data modality, or the people involved). For a person-focused query, give the count.
- Be conversational and concise: one short paragraph, occasionally two. No headings, no bullet lists, no markdown.
- If the projects only partially match, say so plainly. Do not editorialize, praise, or speculate about anyone's expertise or impact.
- Do not mention scores, embeddings, vectors, or how the search works.`;

// Low-level Gemini call: system + single user turn -> text, or null on any
// error/empty response (so callers fall back gracefully).
async function geminiGenerate(system, userText, env, maxTokens) {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: maxTokens },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || '')
      .join('')
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

async function geminiSynthesize(query, context, matches, env, weakNote) {
  const text = await geminiGenerate(
    GEMINI_SYNTH_SYS,
    `Query: ${query}\n\nRetrieved projects:\n${context}${weakNote}`,
    env,
    400,
  );
  if (text && verifyGrounded(text, matches, query)) return text;
  return null;
}

// Chat path for conversational, non-search input (greetings, thanks, "what can
// you do?"). Replies warmly and invites a real search. No retrieval, no cards.
const CONVERSE_SYS = `You are the DASH search assistant for the Charles Perkins Centre Data Science Hub at the University of Sydney. The user has said something conversational — a greeting, thanks, or small talk — rather than searching for a project. Reply warmly and briefly (1-2 sentences), and invite them to ask about past DASH data-science projects. You may note they can search by disease area, data modality, analytical method, or an analyst's name. Do not claim to have found any projects. No markdown.`;

export async function converseAnswer(query, env) {
  if (env.GEMINI_API_KEY) {
    const g = await geminiGenerate(CONVERSE_SYS, query, env, 200);
    if (g) return g;
  }
  try {
    const r = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: CONVERSE_SYS },
        { role: 'user', content: query },
      ],
      temperature: 0.5,
      max_tokens: 120,
    });
    const text = r?.response;
    if (typeof text === 'string' && text.trim()) return text.trim();
  } catch {
    /* fall through to template */
  }
  return "Hi! I'm the DASH assistant — ask me about past DASH projects, for example by disease area, data type, analytical method, or an analyst's name.";
}

export async function synthesizeAnswer(query, matches, env, opts = {}) {
  if (!matches || matches.length === 0) {
    return `I could not find any past DASH projects that match "${query}". Try rephrasing or broadening the question.`;
  }
  const weak = !!opts.weak;
  const context = matches.map(projectLine).join('\n');
  // When the retrieval was rescue-tier only, tell the model so it frames the
  // results as weak/possible matches — keeping the answer consistent with the
  // (weak) cards the UI shows rather than dismissing or overselling them.
  const weakNote = weak
    ? '\n\nIMPORTANT: none of these is a strong match — they are only loosely related to the query. Present them as weak, possible matches the user may or may not find relevant; do not imply they are confident answers.'
    : '';

  // Gemini first when configured; null on any error/ungrounded output so we
  // fall through to the keyless Workers AI path, then the template.
  if (env.GEMINI_API_KEY) {
    const g = await geminiSynthesize(query, context, matches, env, weakNote);
    if (g) return g;
  }

  try {
    const r = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: SYNTH_SYS },
        { role: 'user', content: `Query: ${query}\n\nRetrieved projects:\n${context}${weakNote}` },
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
  if (weak) {
    const extra = matches.length > 1 ? ` (plus ${matches.length - 1} other loosely related)` : '';
    return `I didn't find a strong match for "${query}", but the closest, only loosely related, is "${matches[0].title}"${extra}.`;
  }
  if (matches.length === 1) return `I found one relevant DASH project: "${matches[0].title}".`;
  return `I found ${matches.length} DASH projects relevant to your query; the closest is "${matches[0].title}".`;
}
