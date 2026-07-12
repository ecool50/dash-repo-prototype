// agent.js — the conversational layer over retrieval, fully on Workers AI
// (keyless, no external quota). Single streamed answer per turn:
//   planQuery        : route (chit-chat vs search) + extract people/topic.
//   streamSynthesize : stream a grounded answer over the retrieved projects.
//   streamConverse   : stream a warm reply for non-search chit-chat.
// All degrade to a deterministic template so a flaky model never fails /api/ask.
//
// Each takes the prior conversation turns, so a follow-up ("what about the
// RNA-seq one?") resolves against what was already said instead of being
// searched literally.

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
- intent: "person" (only people named), "topic" (a scientific/topical project search), "mixed" (both), or "chitchat" (a greeting, thanks, small talk, or a question about you/the assistant — NOT a request to find projects; for chitchat, people is [] and topic is "").

The current message may be a follow-up that only makes sense against the conversation so far ("what about the RNA-seq one?", "who ran that?", "tell me more"). Resolve it: write the topic/people it actually refers to, spelling out what the pronoun or shorthand stands for, so the phrase is searchable on its own. A follow-up asking about projects is NOT chitchat.`;

// The frontend sends [{ role: 'user' | 'assistant', text }]. Keep only the last
// few turns: enough to resolve a reference, cheap enough not to slow the 8B
// planner or crowd the synthesis context.
const MAX_HISTORY_TURNS = 6;

export function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({
      role: m.role === 'assistant' || m.role === 'agent' ? 'assistant' : 'user',
      content: m.text.trim(),
    }));
}

export async function planQuery(query, env, history) {
  const fallback = { topic: query, people: [], intent: 'topic' };
  const turns = normalizeHistory(history);
  try {
    const r = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: PLANNER_SYS },
        ...turns,
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

const SYNTH_SYS = `You are the DASH search assistant for the Charles Perkins Centre Data Science Hub at the University of Sydney. You help researchers find relevant past data-science projects. Given the user's query and the projects retrieved for it, write a brief, conversational answer (1-3 sentences).
Rules:
- Use ONLY the provided projects and ONLY the fields given for each one (people, disease, data, samples, methods, tools, languages, question). Never invent projects, people, methods, findings, or numbers.
- Answer the question that was actually asked. If it asks about sample size, tools, methods, or who ran a project, quote the relevant field directly. If the answer is not in the fields provided, say plainly that the catalogue does not record it — never estimate or infer it.
- When several projects satisfy the question (e.g. "which projects used Seurat?"), name EVERY one of them that does, by title — never just the first. Say how many there are. Only leave a project out if it genuinely does not answer the question.
- Refer to each project by its title. Do NOT write reference numbers in your answer — the result cards shown beside your answer already display them. Lead with the best match.
- Do NOT editorialize, praise, or speculate about anyone's expertise; say nothing about biology or disease beyond what the provided fields state.
- If the projects only partially or weakly match, say so plainly.
- Be concise and neutral. No markdown, headings, or bullet lists.
- Earlier turns are context for interpreting the question ONLY. Name only projects from the "Retrieved projects" list in the current message: projects you mentioned in an earlier turn are not retrieved now, and the result cards beside your answer show only the current list.`;

const CONVERSE_SYS = `You are the DASH search assistant for the Charles Perkins Centre Data Science Hub at the University of Sydney. The user has said something conversational — a greeting, thanks, or small talk — rather than searching for a project. Reply warmly and briefly (1-2 sentences), and invite them to ask about past DASH data-science projects. You may note they can search by disease area, data modality, analytical method, or an analyst's name. Do not claim to have found any projects. No markdown.`;

// The grounding context for one project. Everything the answer is allowed to
// state must appear here, so this covers what researchers actually ask about:
// who ran it, disease, data type, sample size, methods, and tools. Fields the
// document does not carry are simply omitted rather than guessed at.
function projectLine(m) {
  const parts = [`[${m.ref_number}] ${m.title}`];
  const list = (v, n) => (Array.isArray(v) && v.length ? (n ? v.slice(0, n) : v).join(', ') : '');

  const inv = m.investigators || {};
  const people = [
    inv.lead_data_scientist,
    Array.isArray(inv.analyst_team) ? inv.analyst_team.join(', ') : inv.analyst_team,
    inv.collaborator,
  ].filter(Boolean).join('; ');
  if (people) parts.push(`people: ${people}`);

  const pd = m.project_details || {};
  const dis = list(pd.disease, 3);
  if (dis) parts.push(`disease: ${dis}`);
  const mod = list(pd.data_modality, 3);
  if (mod) parts.push(`data: ${mod}`);

  const si = pd.sample_info || {};
  const sample = [
    si.n_samples != null ? `n=${si.n_samples}` : '',
    si.organism || '',
    si.sample_type || '',
  ].filter(Boolean).join(', ');
  if (sample) parts.push(`samples: ${sample}`);

  // Methods and tools are listed in full (at most ~12 entries per project).
  // Truncating them is what makes the model hedge — asked "which projects used
  // Seurat?", it cannot confirm a tool that was cut from its own context.
  const am = m.analytical_methods || {};
  const methods = list(am.primary_methods);
  if (methods) parts.push(`methods: ${methods}`);
  const tools = list(am.tools_packages);
  if (tools) parts.push(`tools: ${tools}`);
  const langs = list(am.programming_languages);
  if (langs) parts.push(`languages: ${langs}`);

  const q = m.analytical_questions?.primary_question;
  if (q) parts.push(`question: ${q}`);

  return parts.join(' | ');
}

// A streamed token's text. Workers AI sends a purely numeric token as a JSON
// number, not a string ({"response":90}), so a string-only guard silently
// swallows every digit: "n=90 samples" streams as "n= samples". Accept both.
// Returns '' only for a genuinely absent token, never for "0" or 0.
function tokenText(obj) {
  const r = obj && obj.response;
  if (typeof r === 'string') return r;
  if (typeof r === 'number') return String(r);
  return '';
}

// Run a Workers AI chat completion with streaming, emitting each token as a
// { type:'token' } event. Returns the full text (empty string on failure), so
// callers can fall back to a template only when nothing was produced.
async function streamWorkersAI(system, user, env, emit, maxTokens, turns = []) {
  let full = '';
  try {
    const stream = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: system },
        ...turns,
        { role: 'user', content: user },
      ],
      stream: true,
      temperature: 0.3,
      max_tokens: maxTokens,
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        const t = tokenText(obj);
        if (t !== '') { full += t; await emit({ type: 'token', text: t }); }
      }
    }
    // Process a final data line left without a trailing newline at stream end.
    const tail = buf.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const t = tokenText(JSON.parse(payload));
          if (t !== '') { full += t; await emit({ type: 'token', text: t }); }
        } catch { /* ignore */ }
      }
    }
  } catch {
    /* return whatever streamed before the failure */
  }
  return full;
}

export async function streamConverse(query, env, emit, history) {
  const full = await streamWorkersAI(CONVERSE_SYS, query, env, emit, 120, normalizeHistory(history));
  if (full.trim()) return;
  await emit({
    type: 'token',
    text: "Hi! I'm the DASH assistant — ask me about past DASH projects, for example by disease area, data type, analytical method, or an analyst's name.",
  });
}

// An authoritative, pre-resolved statement of which projects list a named tool.
// The set is computed exactly in search.js; the model's only job is to report
// it. Without this the 8B model names one of two Seurat projects and miscounts,
// and gives a different count run to run.
function toolFacts(toolHits, matches) {
  if (!Array.isArray(toolHits) || !toolHits.length) return '';
  const titleOf = new Map(matches.map((m) => [m.ref_number, m.title]));
  const lines = toolHits
    .map(({ tool, refs }) => {
      const titles = refs.map((r) => titleOf.get(r)).filter(Boolean);
      if (!titles.length) return '';
      return `- Exactly ${titles.length} of the retrieved projects list the tool "${tool}": ${titles.map((t) => `"${t}"`).join('; ')}.`;
    })
    .filter(Boolean);
  if (!lines.length) return '';
  return `\n\nESTABLISHED FACTS (already checked against the catalogue's tool lists — treat as true, do not re-derive, do not second-guess):\n${lines.join('\n')}\nIf the question is about one of these tools, name every project listed for it and state that exact count. Do not add or drop any.`;
}

export async function streamSynthesize(query, matches, env, opts, emit) {
  if (!matches || matches.length === 0) {
    await emit({
      type: 'token',
      text: `I could not find any past DASH projects that match "${query}". Try rephrasing or broadening the question.`,
    });
    return;
  }
  const weak = !!(opts && opts.weak);
  const context = matches.map(projectLine).join('\n');
  const weakNote = weak
    ? '\n\nIMPORTANT: none of these is a strong match — they are only loosely related to the query. Present them as weak, possible matches; do not imply they are confident answers.'
    : '';

  const facts = toolFacts(opts && opts.toolHits, matches);

  const full = await streamWorkersAI(
    SYNTH_SYS,
    `Query: ${query}\n\nRetrieved projects:\n${context}${facts}${weakNote}`,
    env,
    emit,
    // Enough room to name every match: four long project titles overrun a
    // tighter cap and the answer gets truncated mid-sentence.
    360,
    normalizeHistory(opts && opts.history),
  );
  if (full.trim()) return;

  // Nothing streamed — deterministic template fallback.
  if (weak) {
    const extra = matches.length > 1 ? ` (plus ${matches.length - 1} other loosely related)` : '';
    await emit({ type: 'token', text: `I didn't find a strong match for "${query}", but the closest, only loosely related, is "${matches[0].title}"${extra}.` });
    return;
  }
  await emit({
    type: 'token',
    text: matches.length === 1
      ? `I found one relevant DASH project: "${matches[0].title}".`
      : `I found ${matches.length} DASH projects relevant to your query; the closest is "${matches[0].title}".`,
  });
}
