# Exact / catalogue-wide query path (WS2)

Status: implemented in `option_b/api/`, July 2026. Deterministic, no model in the
answer loop. This document explains why it exists, how it routes, and the one
design decision (the data-type taxonomy) that needs DASH sign-off.

## Problem it fixes

The agent had a single way to answer any non-chit-chat turn: embed the query,
vector-search the nearest projects, rerank, keep the top K (8), and let an LLM
phrase an answer over that slice. That is correct for *fuzzy* questions but wrong
for *exact* ones, and it produced three reported failures:

1. **Invented counts.** Asked to "summarise the number of projects by data type",
   the agent reported figures like "Transcriptomics: 5, Single-cell: 12" for a
   catalogue of **11 projects**. A top-K semantic slice has no notion of "all",
   so a catalogue-wide count is unanswerable from it; the model filled the gap
   from its training priors and made numbers up.
2. **Invented projects.** Pushed to "retrieve all 5", it fabricated projects
   (e.g. a `[0019]` with invented investigators) to satisfy a count that never
   existed.
3. **Incomplete category retrieval.** "List all transcriptomics projects"
   returned 2, because the two RNA-seq projects (0052, 0054) have modality
   strings that never contain the word "transcriptomics", so the embedding could
   not recall them.

The root cause is using a fuzzy, incomplete selector (embeddings) for exact
operations. Embeddings are lossy at the *selection* boundary (ranked top-K, no
"all", imperfect recall), not because the model reads a compressed vector — it
reads clean project text. A stronger model does not fix this; a different
retrieval mechanism does.

## The principle

Match the retrieval mechanism to the query type.

| Query type | Example | Mechanism |
| --- | --- | --- |
| Fuzzy / semantic | "projects about skin inflammation" | embedding + reranker (unchanged) |
| Count / total | "how many projects are there" | direct DB read, count |
| List all | "list every project" | direct DB read, enumerate |
| Breakdown | "summarise by data type / disease / tool" | direct DB read, group in code |
| Named category | "all transcriptomics projects" | direct DB read, structured field match |
| Named tool | "which projects use Seurat" | exact field match (`search.js matchByTool`, WS4) |

Every number in an exact answer originates in MongoDB. The model is not in the
loop for WS2, so a count can never be hallucinated.

## Flow

`ask.js` runs `classifyCatalogue(text)` **before** the planner and before any
embedding. If it returns an intent, the turn is answered from `runCatalogue` and
`streamAggregate`; embed / vector / rerank / planner never run. If it returns
`null`, the turn falls through to the existing semantic pipeline unchanged.

```
ask.js
  classifyCatalogue(clean)  --null-->  planQuery -> searchProjects -> streamSynthesize   (semantic, unchanged)
        |
     intent
        |
  runCatalogue(intent, env)      one find() over all 11 docs, projection minus vector
        |
  (list/category) emit {type:'matches'} cards
        |
  streamAggregate(result, env, emit)   deterministic grounded sentence, one token event
```

Files:
- `option_b/api/catalogue.js` — classifier + execution (new).
- `option_b/api/agent.js` — `streamAggregate`, `aggregateText`, `AGG_SYS` (added).
- `option_b/api/ask.js` — the pre-planner route (added).

## Classifier

`classifyCatalogue(text)` is deterministic regex over the lowercased query. It
returns `null` or one of:

- `{ kind: 'total' }` — "how many projects", "number of projects in the database".
- `{ kind: 'list' }` — "list all projects", "show me every project".
- `{ kind: 'group', facet }` — `facet` in `data_type | disease | tool | method`.
  Fires on an aggregate verb + a facet keyword ("summarise by data type"), or
  when the facet noun is the enumerated subject ("which tools are used").
- `{ kind: 'category', facet: 'data_type', type }` — a named data type +
  enumerate/count intent ("list all transcriptomics projects", "how many
  proteomics projects"). Also answers the count for that type.

Precedence: group -> category -> list -> total. A named type only intercepts when
the query clearly enumerates or counts, so ordinary semantic queries
("transcriptomics biomarker methods") fall through to vector search.

Guards that keep an EXACT answer from being confidently wrong (all added after an
adversarial testing pass, all fall through to semantic search rather than
answering):
- **Negation** ("projects that are NOT transcriptomics", "excluding proteomics",
  "without imaging"): an affirmative exact answer would be returned inverted, so
  any negation term short-circuits to null.
- **Multiple types** ("proteomics and transcriptomics projects"): would otherwise
  answer for only the first type and silently drop the rest.
- **Qualified category** ("which transcriptomics projects used RNA velocity"): a
  type term plus any other content word is a filtered semantic question, not a
  whole-category enumeration. `isBareTypeQuery` enforces this, mirroring the
  bareness guard the list/total branches use.

## Execution and grounding

`runCatalogue` pulls all documents once (11 small docs, vectors projected out)
and computes every answer in JS. One DB round trip keeps the Durable-Object hop
count low (the historical Cloudflare 1101 surface). Counts are **distinct
projects per bucket**. Because a project can fall in several buckets, bucket
counts do not sum to the total, and every answer states that explicitly.

`streamAggregate` emits a single deterministic sentence built by `aggregateText`.
`AGG_SYS` exists for a later, optional model-phrasing pass (WS1/Gemini) that may
reword the sentence but is forbidden from changing any number; it is not wired in
now.

## Data-type taxonomy — REVIEW REQUIRED

The `data_modality` field is **free text, not a controlled vocabulary**. Across
the 11 live projects there are ~34 distinct modality strings, nearly all unique,
mixing assay type ("proteomics", "CUT&RUN"), data representation ("peak-by-sample
matrix", "gene counts"), and readout ("survival outcomes"). Grouping on the raw
field yields ~34 buckets of size 1 — exact but useless as a "by data type"
summary. Disease is similar (10 near-unique values); only tools genuinely repeat.

So "by data type" is answered through a **canonical taxonomy** in
`catalogue.js` (`DATA_TYPES`) that buckets raw modality strings into high-level
types. **The mapping is a judgement call the DASH team should review.** It lives
in one editable constant. Current assignment of the 11 projects:

| Ref | Data type(s) | Basis (raw modality) |
| --- | --- | --- |
| 0037 | proteomics, imaging, spatial | imaging mass cytometry; spatial proteomics; multiplexed tissue imaging |
| 0040 | transcriptomics, spatial | 10x Xenium; imaging-based single-cell transcriptomics |
| 0042 | epigenomics | CUT&RUN; peak-by-sample; promoter peak signal |
| 0046 | transcriptomics, spatial | spatial transcriptomics; single-cell spatial gene expression |
| 0047 | wearable / sensor | accelerometer; wrist/thigh sensor |
| 0051 | clinical / meta-analysis | systematic review; survival / radiotherapy outcomes |
| 0052 | transcriptomics | bulk RNA-seq; gene counts |
| 0054 | transcriptomics | single-cell RNA-seq |
| 0055 | proteomics | proteomics; DIA mass spectrometry |
| 0057 | study design / biostatistics | `data_modality` **empty**; classified from research_area / primary_methods (sample size, power analysis) |
| 0076 | epigenomics | CUT&RUN; H3K4me2 / H3K27me3 histone marks |

Resulting breakdown: transcriptomics 4, spatial 3, epigenomics 2, proteomics 2, imaging 1,
clinical/meta 1, study design 1, wearable/sensor 1, and **0 unclassified**.
(These overlap: 0037 is counted in both proteomics and imaging, so they do not
sum to 11.)

`study_design` is a **non-assay** type: some consults generate no data of their
own (0057 is a sample-size / power analysis). It carries `nonAssay: true` and is
applied by `projectDataTypes()` only as a FALLBACK — when a project matched no
assay type — scanning `research_area` + `primary_methods` instead of
`data_modality`. Add other methods-only categories the same way.

Open questions for review:
- RESOLVED (July 2026): "spatial" IS its own cross-cutting type (0037, 0040,
  0046), tagged in addition to the assay type (0040 is transcriptomics AND spatial).
- Should 0037 (imaging mass cytometry) be "imaging", "spatial proteomics", or
  both, as now?
- Are there other methods-only consult categories (e.g. pipeline/QC, simulation)
  that deserve their own non-assay type alongside study design?

To change the taxonomy, edit `DATA_TYPES` in `catalogue.js` (each entry has
`match` substrings for the stored field and `query` synonyms for user phrasing).

## Related: WS1 route/execute cascade (the LLM router)

The regex `classifyCatalogue` is phrasing-brittle: "list all transcriptomics
projects" hit the exact path but "retrieve the transcriptomics projects" fell
through to semantic search and returned an incomplete set. The fix keeps the
deterministic executors but moves ROUTING to a model, so equivalent phrasings
route the same. Split: the model classifies INTENT (it never counts or lists,
so it cannot fabricate a number); deterministic code executes.

`ask.js` is the dispatcher, in a cascade:
1. `classifyCatalogue` (regex) — instant fast path for the clear cases.
2. On a miss, `router.js` — an LLM intent router on **keyless Cloudflare Workers
   AI** (`@cf/meta/llama-3.1-8b-instruct-fast`, JSON-schema constrained output,
   `data_type` enum-locked to the taxonomy). Gemini was rejected: its free tier
   rate-limits to unusability, and it costs the keyless/governance property. It
   stays a one-line swap if a paid key is ever added.
3. `guardIntent` cross-checks the router: a claimed `data_type`/`facet`/`value`
   the query doesn't support downgrades to semantic search (never a wrong
   authoritative count), and a missing `data_type` is recovered from the query
   text (handles negated queries the 8B under-fills).
4. Still nothing -> the legacy planner splits chitchat vs a topical search.

Executors: `runCatalogue` (total / list / breakdown / category, plus **count_by_value**
for "how many use Seurat" and **negated category** for the complement) and
**categoryRanked** in `search.js` (filter to the complete typed set, order by the
qualifier) for "transcriptomics work on atopic dermatitis". Numbers still come
only from the DB. `POST /api/route` returns the raw intent (no execution) as a
standing router-quality eval hook.

Live-verified end to end. Known limitation (pre-existing, not from this change):
disease-named semantic queries under-recall ("who worked on the leukaemia
project"), because `searchProjects` structured-matches tools and investigators
but not diseases; a `matchByDisease` mirroring `matchByTool` would close it.

### Guard invariants (`guardIntent`)

The small router occasionally mislabels a query. Every structured intent has a
deterministic precondition; if it fails, the intent DOWNGRADES to semantic search
(which shows results and lets the user judge) rather than emit a confidently
wrong authoritative answer. The complete set:

| Intent | Precondition | On failure |
| --- | --- | --- |
| `category` | the named `data_type` synonym actually appears in the query | downgrade to semantic |
| `category` (empty data_type) | exactly one data type is named in the query text | recover that type; else semantic |
| `count_by_value` | a `value` is present and `facet` in {tool, disease, method} | downgrade to semantic |
| `breakdown` | `facet` valid AND a grouping cue in the query ("by", "per", "distribution", "summarise", ...) | downgrade to semantic |
| `person` | at least one name in `people` | downgrade to semantic |

The regex fast path is trusted (it only fires on structurally unambiguous
queries); these guards apply to the LLM router's output. New misroutes get a new
row here and a locked case in `eval/cases.mjs`.

### The eval gate (diligence)

Routing is probabilistic, so correctness is enforced by evals, not hope:

- **`eval/offline.mjs`** — deterministic pre-deploy gate (classifier never
  mis-fires, guard invariants hold, executor counts are exact), run against
  `eval/fixtures.json` with no network or model. **Wired into CI** (`deploy-worker.yml`):
  a red gate blocks the deploy.
- **`eval/live.mjs`** — post-deploy check of router quality (`/api/route`) and
  full cascade behaviour (`/api/ask`) against the deployed Worker.
- **`eval/cases.mjs`** — the shared corpus. Every production misroute we have
  found is a locked case (marked `bug`); `knownGap` cases are reported but do not
  gate. Growing this corpus is how the system gets more reliable over time.

## Related: WS3 grounding guard + history de-poisoning

The semantic synthesis answer (`agent.js streamSynthesize`) is where the agent
invented projects — a fake `[0019]` with a real investigator grafted on, produced
under pressure from its own earlier hallucination in the conversation history.
Two changes:

- **Grounding guard (buffer-then-verify).** The synthesis answer is now
  COLLECTED in full instead of streamed live, checked by `verifyGrounded`, then
  emitted. If it clears, it is shown; if it names something outside the retrieved
  set, it is discarded and the deterministic template (which can only name real
  matches) is shown instead. Cost: the short prose appears ~0.5-1s later, but a
  fabricated result is never displayed. Cards still render immediately (ask.js
  emits them first). This is a deliberate, scoped reversal of the "stream
  everything" decision — you cannot retract a streamed token, so the answer that
  needs a guarantee is buffered; chit-chat still streams live.
  `verifyGrounded` is HIGH PRECISION on purpose (a false flag needlessly
  downgrades a good answer): it flags only (A) a reference number not in the
  retrieved set — the signal that catches the real `[0019]` failure — and (B) a
  "Dr/Prof <name>" sharing no token with any retrieved investigator. A bare
  invented title is not caught here; the prompt's allow-note is the first line of
  defence.
- **History de-poisoning.** Prior turns are no longer passed to synthesis as peer
  chat messages. They are folded into one labelled, clipped, reference-ONLY block
  ("NOT a project list and NOT a source of facts"); assistant turns are clipped
  to 200 chars, user turns kept verbatim. So a hallucinated earlier turn can no
  longer be cited as fact, while "the RNA-seq one" still resolves. `verifyGrounded`
  is the backstop if the model parrots a stale fabricated title anyway.

Verified by `scratchpad/ws3-test.mjs`: verifyGrounded unit cases (real refs /
real investigators pass; fabricated `[0019]` and fake "Dr" names rejected;
person-check skipped when the match lists no people), the end-to-end
buffer-then-verify (a fabricated model answer falls back to a real-match
template), and the structural history fix (no assistant peer-message reaches the
model; the labelled block is present). All pass.

## Related: WS4 tool-match gate

Separate but shipped alongside this: `search.js` now gates `matchByTool` behind
`isToolLookupCandidate(text)` so the exact tool lookup only runs for a SHORT,
question/usage-framed message. Previously any message merely CONTAINING a package
name fired it — most damagingly a user pasting a project blurb ("... tools:
Seurat, limma ..."), which hijacked the answer with an unsolicited "projects
using Seurat" block. The gate rejects text over ~16 words / ~140 chars and text
with no question or usage frame. "which projects use Seurat?" still passes.

## Verification

Two offline suites run against the real 11 documents (fed through a fake Mongo
proxy / fake Workers-AI stream, since local Atlas auth is dead):
- `scratchpad/stress-test.mjs` — WS2 + WS4: classifier intercepts and
  must-fall-throughs (including the adversarial set: negation, multi-type,
  type+qualifier, "how many projects use Seurat", "list all leukaemia projects"),
  grounded-answer invariants (real numbers, overlap caveat, 0 unclassified, 0057
  -> study design, transcriptomics = 4), a malformed-doc robustness block
  (non-array / null / missing fields must not crash `runCatalogue`), and the WS4
  tool gate against the real pasted [0019] blurb.
- `scratchpad/ws3-test.mjs` — WS3: `verifyGrounded` unit cases (bracketed and
  prefixed refs rejected; bare 4-digit numbers like n=0400 intentionally NOT
  treated as refs; fabricated / 2-char / accented names rejected; the "and" leak
  from multi-name fields closed), buffer-then-verify fallback, and the structural
  history fix.

These were hardened after an adversarial review pass (three reviewer personas +
an evidence-based QA agent) that found and drove fixes for: negation/multi-type
inversions, an unguarded qualified-category interception, a non-array
`data_modality` crash, and a `verifyGrounded` false-positive on zero-leading
4-digit sample sizes. End-to-end verification against the deployed Worker still
needs a working `ATLAS_URI` or a run against the live API.

### Known, accepted limitations
- `verifyGrounded` is a high-precision backstop, not a complete fabrication
  detector: a bare invented title with no reference number and no "Dr/Prof" name
  is not caught (the prompt's allow-note is the first line of defence). Bare
  names without a title are likewise not checked.
- The WS4 tool gate is heuristic: a short tool STATEMENT ("we used Seurat") still
  passes, and a very long genuine tool question (>16 words) is missed. The gate's
  job is to stop the pasted-blurb hijack, which it does.
- Compound breakdowns ("by disease and data type") group on the first facet only.
