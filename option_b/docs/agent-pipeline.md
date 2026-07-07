# The `/api/ask` conversational agent

`POST /api/ask` is the conversational surface of the DASH repository: a user
asks in natural language and gets a written answer plus the matched project
cards. This document describes the pipeline behind it as deployed in `api/`.

Companion docs: `architecture.md` (system overview), `setup.md` (running
locally).

## Request / response

```
POST /api/ask
{ "query": "what methods did that project use?",
  "limit": 5,
  "history": [ { "role": "user"|"assistant", "text": "..." }, ... ] }

-> { "answer":  "<written answer>",
     "matches": [ <project document with .score>, ... ],
     "searched": true }
```

`history` is the recent conversation (most-recent last); it lets the agent
resolve follow-ups ("that project", "the first one"). `searched` reports whether
the agent hit the database this turn — the frontend keeps the current cards when
it is `false` (a chat or context-only follow-up) and replaces them when `true`.
`answer` and `matches` are always consistent — the agent never claims results
the cards contradict.

## Two paths

`/api/ask` has a primary agent path and a deterministic fallback:

1. **Tool-using agent** (`agent-loop.js`, Gemini function calling) — used when
   `GEMINI_API_KEY` is set. The model decides each turn whether to search, fetch
   a project, or just reply. This is what stops the system searching on every
   message.
2. **Deterministic pipeline** (`ask.js: pipelineAnswer`) — used when Gemini is
   absent or the agent loop returns null / errors. Always works, keyless,
   single-turn. Described under [Fallback pipeline](#fallback-pipeline) below.

## Tool-using agent — `agent-loop.js`

The agent runs a short tool loop (max 4 steps) against Gemini with two tools:

- `search_projects(query, person?)` — semantic search (the full retrieval stack
  below). For a NEW information need.
- `get_project(ref_number)` — full record for one project. For drilling into a
  project already under discussion.

Per turn the model is instructed to:

- **not** call a tool for small talk / "what can you do?" → replies directly,
  `searched: false`, no cards change;
- answer follow-ups from the conversation, calling `get_project` only when it
  needs more detail than it already has → one cheap single-doc read, no vector
  search;
- call `search_projects` only for a genuinely new need.

Every project a tool returns this turn is gathered (deduped by `ref_number`) and
returned as `matches` for the cards. Before returning, the final answer passes a
reference-grounding check (`refsGrounded`): any project ref it cites must be one
actually gathered. If the answer is empty, cites an invented ref, or the loop
exhausts its step budget, `agentLoop` returns `null` and `ask.js` falls back to
the deterministic pipeline. Conversation history is capped to the last 8 turns.

## Fallback pipeline

```
query
  │
  ▼
1. planQuery (LLM)         extract people + a clean topic; classify intent
  │
  ├─ intent = chitchat ──► 2a. converseAnswer (LLM) ─► { answer, matches: [] }
  │
  ▼ (search intents)
2b. searchProjects          embed → vector recall → rerank → weak/strong flag
  │                         (+ structured investigator-name match)
  ▼
3. synthesizeAnswer (LLM)   grounded, conversational summary of the matches
  │
  ▼
{ answer, matches }
```

### 1. Query planning — `agent.js: planQuery`

A Workers AI Llama call (`@cf/meta/llama-3.1-8b-instruct-fast`, `temperature 0`,
JSON-schema constrained) parses the raw query into:

- `people` — investigator names the query asks about (`[]` if none).
- `topic` — the scientific/topical part as a clean search phrase, filler and
  names stripped; general disease terms get obvious synonyms appended.
- `intent` — `person`, `topic`, `mixed`, or `chitchat`.

Planned `topic` drives semantic search; planned `people` drive the structured
investigator match. On any model error it falls back to
`{ topic: query, people: [], intent: 'topic' }`, so a flaky planner biases
toward searching rather than failing.

### 2a. Chit-chat routing — `ask.js` + `agent.js: converseAnswer`

When `intent === 'chitchat'` **and** the planner extracted no topic and no
people, the request skips retrieval entirely and returns a warm conversational
reply with `matches: []`. This is what makes a greeting ("hi", "how's it
going", "thanks") get a friendly answer and **no** project cards, instead of
noise-tier matches under a "nothing matches" message.

The guard (`intent === 'chitchat' && !people.length && !topic`) means a
mislabelled real query — chit-chat intent but with an extracted topic — still
runs the search.

### 2b. Retrieval — `search.js: searchProjects`

Two-stage retrieval plus a structured name match:

1. **Abbreviation expansion** (`abbrev.js: expandAbbreviations`) — the query is
   expanded once (`"scRNA seq"` → `"single-cell RNA sequencing scRNA-seq"`,
   `"IMC"` → `"imaging mass cytometry IMC"`) and the expanded text feeds **both**
   the embedding and the reranker. Without this, `bge-large` treats an acronym
   as unrelated to its spelled-out form (`"IMC"` alone returns nothing) and, even
   if recall improved, the cross-encoder would re-score the raw acronym and drop
   the matches again. The map is shared with no other consumer today, but lives
   in `abbrev.js` so a document-side use stays consistent. Extend the list as new
   abbreviations appear.
2. **Vector recall** — embed the expanded query
   (`@cf/baai/bge-large-en-v1.5`, with the asymmetric query instruction prefix),
   `$vectorSearch` over `embedding.vector` (`numCandidates: 200`, overfetch
   `max(limit × 4, 20)`), structured filters merged in.
3. **Rerank** — a cross-encoder (`@cf/baai/bge-reranker-base`) scores true
   query/passage relevance in `[0,1]`, reorders, and applies floors:
   - `RERANK_FLOOR = 0.1` — keep strong matches above this.
   - `RESCUE_FLOOR = 0.03` — if nothing clears the strong floor, rescue the
     weaker-but-relevant tail rather than returning nothing, and set `weak: true`.
   - Returns `{ results, weak }`. `weak` tells the agent the matches are
     rescue-tier so it can frame them honestly.
4. **Investigator match** — planned `people` (or name-like tokens from a direct
   `/api/search`) are matched against investigator fields directly, because a
   name buried in prose reranks too low to surface. An exact name match is a
   confident hit, so its presence clears the `weak` flag.

`searchProjects` returns `{ results, weak }`. `embedding.vector` is stripped
from every result.

### 3. Answer synthesis — `agent.js: synthesizeAnswer`

Writes the conversational answer grounded in the retrieved projects. Provider
chain, each step falling through on failure so the request never fails on a
flaky or refusing model:

1. **Gemini** (`gemini-2.5-flash`) when `GEMINI_API_KEY` is set — a warm,
   assistant-style grounded summary.
2. **Workers AI Llama** (`@cf/meta/llama-3.1-8b-instruct-fast`) — the keyless
   fallback; terser, neutral.
3. **Deterministic template** — last resort, no model.

Both LLM outputs pass `verifyGrounded` (below); an answer that fails the guard
is discarded and the next provider runs. When `searchProjects` returned
`weak: true`, a note is injected into the prompt (and a matching template used)
instructing the model to present the results as weak, possible matches — so
`"what projects used Seurat?"` reads "I didn't find a strong match; the closest,
only loosely related, is …" rather than dismissing or overselling the card.

#### Grounding guard — `agent.js: verifyGrounded`

A deterministic check on generated answers:

- Any project-reference-like token in the answer must be one of the retrieved
  refs (catches invented projects).
- Any quoted multi-word span must be traceable to the retrieved context or the
  query (catches invented titles/quotes).

It does **not** catch relational misattribution (a real analyst paired with the
wrong real project) — that would need an LLM judge.

## Configuration

Models (in `agent.js` / `search.js`):

| Role | Model |
|------|-------|
| Query planner + synthesis fallback | `@cf/meta/llama-3.1-8b-instruct-fast` |
| Query + document embedding | `@cf/baai/bge-large-en-v1.5` |
| Reranker | `@cf/baai/bge-reranker-base` |
| Primary synthesis (optional) | Gemini, `gemini-2.5-flash` |

The 8B Llama is deliberate: the 70B model (~2.5 s/call) plus Mongo kept the
isolate busy ~6 s and tipped it into Cloudflare 1101 crashes ("Failed to
fetch"). Gemini synthesis runs off-isolate (external `fetch`), so it does not
add to that isolate-CPU budget, but it does add network latency and a failure
mode — hence the guarded fallback chain.

Secrets / vars (`api/wrangler.toml`):

| Name | Purpose |
|------|---------|
| `ATLAS_URI` (secret) | MongoDB Atlas connection string |
| `GEMINI_API_KEY` (secret) | Google AI Studio key. If unset, synthesis uses the keyless Workers AI path. |
| `GEMINI_MODEL` (var, optional) | Overrides the default `gemini-2.5-flash`. |

Set the Gemini key with:

```
cd api && npx wrangler secret put GEMINI_API_KEY
```

Retrieval thresholds live in `search.js`: `RERANK_FLOOR`, `RESCUE_FLOOR`,
`OVERFETCH_FACTOR`, `MIN_OVERFETCH`. They are calibrated against the current
(illustrative) catalogue and should be re-tuned once real data lands.

## Files

| File | Responsibility |
|------|----------------|
| `api/ask.js` | Entry point: try the agent loop, else the deterministic fallback pipeline. |
| `api/agent-loop.js` | Tool-using agent (Gemini function calling): `search_projects` + `get_project`, grounding check, history. |
| `api/agent.js` | Fallback pipeline pieces: `planQuery`, `converseAnswer`, `synthesizeAnswer`, `verifyGrounded`, Gemini + Workers AI calls. |
| `api/search.js` | Embedding, vector search, rerank, weak flag, investigator match. |
| `api/abbrev.js` | Shared omics/assay abbreviation map + `expandAbbreviations`. |
| `api/mongo.js` / `api/mongo-do.js` | Atlas access via a Durable Object (connection off the request path). |

## Design notes

- **Consistency over cleverness.** Abbreviation handling is a deterministic map,
  not an LLM query-rewriter, precisely because the reported bug was
  *inconsistency* ("scRNA seq" and "single cell RNA seq" returning different
  results). An LLM rewriter reintroduces nondeterminism, latency, and a
  hallucination surface.
- **Index-time vs query-time context.** Document-side abbreviation expansion was
  evaluated and dropped: the catalogue already stores spelled-out modality
  names, so expanding the doc side only duplicated terms without adding recall.
  The open follow-up for richer recall is LLM enrichment of `source_text` at
  ingest (plain-language blurb + synonyms), which requires re-embedding the
  catalogue.
- **Graceful degradation everywhere.** Planner, both synthesis providers, the
  investigator match, and the query log each fail soft — no single model or
  lookup can turn a search into an error. The whole agent loop is itself a
  fail-soft layer over the deterministic pipeline.
- **Don't search every message.** The agent decides when retrieval is needed, so
  greetings and follow-ups ("what methods did that one use?") no longer trigger a
  vector search + rerank. This cuts latency, Workers AI spend, and isolate load.
  The tradeoff is a possible misroute (a new query mistaken for a follow-up); the
  loop biases toward searching and falls back to the deterministic pipeline when
  the model's answer isn't grounded.
