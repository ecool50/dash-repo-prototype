// agent-loop.js — tool-using conversational agent for POST /api/ask.
//
// Instead of searching on every message, the LLM (Gemini function calling)
// decides each turn what to do:
//   - small talk / "what can you do?"        -> just reply, no tool, no DB hit
//   - follow-up on projects already shown     -> answer from conversation, or
//                                                get_project for more detail
//   - a genuinely new information need         -> search_projects
//
// Returns { answer, matches, searched }:
//   matches  — full project docs gathered via tools THIS turn (for the cards)
//   searched — whether a tool ran; the frontend keeps the existing cards when
//              false (a pure chat/context turn) and replaces them when true.
// Returns null on any failure so ask.js can fall back to the deterministic
// plan -> search -> synth pipeline.

import { searchProjects, getProject } from './search.js';

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_STEPS = 4;          // tool round-trips before we give up and fall back
const SEARCH_LIMIT = 8;
const MAX_HISTORY_TURNS = 8;

const AGENT_SYS = `You are the DASH search assistant for the Charles Perkins Centre Data Science Hub at the University of Sydney. You help researchers find and understand past data-science projects. Speak like a helpful, knowledgeable colleague.

You have tools:
- search_projects: semantic search over the project catalogue. Use it when the user asks about a NEW topic, disease, method, data type, or person.
- get_project: fetch the full record for ONE project by its reference number. Use it when the user drills into a specific project already under discussion and you need detail (methods, tools, questions) beyond what you already have.

Decide each turn:
- If the user is making small talk, greeting you, or asking what you can do, just reply warmly — do NOT call a tool.
- If the user is asking a follow-up about projects already shown in this conversation, answer from that context; only call get_project when you need more detail than you already have.
- Only call search_projects for a genuinely new information need. Do not re-search for something already in the conversation.

Grounding rules:
- Use ONLY information from tool results or earlier in this conversation. Never invent projects, people, methods, or findings.
- Refer to projects by title and reference number (e.g. "0055").
- Be conversational and concise: a short paragraph. No markdown, headings, or bullet lists.
- If a search returns weak/loosely-related results, say so honestly. If nothing matches, say so and suggest how to rephrase.`;

const TOOLS = [
  {
    function_declarations: [
      {
        name: 'search_projects',
        description:
          'Semantic search over the DASH project catalogue for a topic, disease, method, data modality, or person. Returns matching projects with reference numbers.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The topical search phrase (disease, method, data type, etc.).',
            },
            person: {
              type: 'string',
              description: 'An investigator or analyst name to match, if the user asked about a person.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_project',
        description:
          'Fetch the full record for a single project by its reference number (e.g. "0055").',
        parameters: {
          type: 'object',
          properties: {
            ref_number: { type: 'string', description: 'The project reference number.' },
          },
          required: ['ref_number'],
        },
      },
    ],
  },
];

export async function agentLoop(query, history, env) {
  const contents = [...normalizeHistory(history), { role: 'user', parts: [{ text: query }] }];
  const gathered = [];
  let searched = false;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const data = await geminiCall(contents, env);
    const cand = data?.candidates?.[0]?.content;
    if (!cand || !Array.isArray(cand.parts)) return null;
    contents.push(cand);

    const calls = cand.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (calls.length === 0) {
      const text = cand.parts.map((p) => p.text || '').join('').trim();
      if (!text || !refsGrounded(text, gathered)) return null; // fall back
      return { answer: text, matches: gathered, searched };
    }

    searched = true;
    const parts = [];
    for (const c of calls) {
      const response = await runTool(c.name, c.args || {}, env, gathered);
      parts.push({ functionResponse: { name: c.name, response } });
    }
    contents.push({ role: 'user', parts });
  }
  return null; // exhausted step budget -> fall back
}

async function geminiCall(contents, env) {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: AGENT_SYS }] },
      contents,
      tools: TOOLS,
      generationConfig: { temperature: 0.3, maxOutputTokens: 500 },
    }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  return res.json();
}

async function runTool(name, args, env, gathered) {
  if (name === 'search_projects') {
    const query = String(args.query || '').trim();
    const person = String(args.person || '').trim();
    const res = await searchProjects(
      { query, people: person ? [person] : undefined, limit: SEARCH_LIMIT },
      env,
    );
    const results = res.results || [];
    addGathered(gathered, results);
    return { projects: results.map(searchDigest), weak: !!res.weak, count: results.length };
  }
  if (name === 'get_project') {
    const ref = String(args.ref_number || '').trim().replace(/^CPCDASH/i, '');
    try {
      const doc = await getProject(ref, env);
      addGathered(gathered, [doc]);
      return fullDigest(doc);
    } catch {
      return { error: `No project found with reference ${ref}.` };
    }
  }
  return { error: `Unknown tool ${name}.` };
}

// --- helpers ---------------------------------------------------------------

// Compact project view the model sees for search hits: enough to talk about a
// match without dumping the whole document.
function searchDigest(doc) {
  const inv = doc.investigators || {};
  const people = [
    inv.lead_data_scientist,
    Array.isArray(inv.analyst_team) ? inv.analyst_team.join(', ') : inv.analyst_team,
    inv.collaborator,
  ].filter(Boolean).join('; ');
  return {
    ref_number: doc.ref_number,
    title: doc.title,
    people: people || undefined,
    disease: doc.project_details?.disease,
    data_modality: doc.project_details?.data_modality,
    score: typeof doc.score === 'number' ? Number(doc.score.toFixed(3)) : undefined,
  };
}

// Richer view for a drill-in via get_project.
function fullDigest(doc) {
  return {
    ...searchDigest(doc),
    status: doc.status,
    primary_methods: doc.analytical_methods?.primary_methods,
    tools_packages: doc.analytical_methods?.tools_packages,
    programming_languages: doc.analytical_methods?.programming_languages,
    primary_question: doc.analytical_questions?.primary_question,
  };
}

function addGathered(gathered, docs) {
  for (const d of docs) {
    if (d && d.ref_number && !gathered.some((g) => g.ref_number === d.ref_number)) {
      gathered.push(d);
    }
  }
}

// Any project-reference token the answer cites must be one we actually gathered
// this turn (or the conversation carried). Guards against invented refs; if it
// fails we fall back to the deterministic pipeline.
function refsGrounded(text, gathered) {
  const refs = new Set(gathered.map((g) => String(g.ref_number).toLowerCase()));
  for (const tok of text.match(/\bCPCDASH\d{3,4}\b|\b0\d{3}\b|\bA\d{1,2}\b/gi) || []) {
    const norm = tok.toLowerCase().replace(/^cpcdash/, '');
    if (!refs.has(norm) && !refs.has(tok.toLowerCase())) return false;
  }
  return true;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({
      role: m.role === 'assistant' || m.role === 'agent' ? 'model' : 'user',
      parts: [{ text: m.text.trim() }],
    }));
}
