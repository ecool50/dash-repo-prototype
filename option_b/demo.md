# DASH Repository: Demo Script

This is the script for the supervisor demo of the DASH Repository mockup.
It assumes the Worker is deployed, Atlas is loaded with the ten A-series
illustrative projects, and the frontend is wired to the Worker URL.

The demo tells one story in three beats:

1. **It works end to end.** A researcher types a natural-language question
   and gets relevant past projects.
2. **The matching is semantic, not keyword.** Queries match projects even
   when the vocabulary differs.
3. **Adding new projects is a workflow, not a chore.** A push to GitHub
   triggers ingestion. (Shown as a workflow walkthrough, not fired live.)

Total length, including questions: about 15 minutes.

---

## Pre-demo checklist

Run through this 30 minutes before the audience arrives.

```
[ ] Atlas dashboard shows the cluster is up and dash.projects has 10 docs
[ ] Search indexes projects_vector and projects_text show "Active"
[ ] option_b/scripts/smoke.sh https://<worker-url> exits 0 (all PASS)
[ ] The frontend loads at its URL in a private browser window
[ ] All four sample queries below return results (no spinner forever, no 500s)
[ ] A backup terminal window has the curl commands pre-typed, ready to paste
    in case the frontend hangs (see "Recovery" at the bottom)
[ ] Mute notifications, close unrelated tabs, full-screen the browser
[ ] If projecting: confirm the projector resolution doesn't clip the frontend
```

If any item fails, stop and fix before continuing. A live failure during the
demo is much worse than a fifteen-minute delay before it.

---

## The demo flow

### Beat 1: "It works"

Open the frontend. Show the empty search box.

> "This is the search surface researchers will use. They type a question in
> plain English. There's no browse view, no faceted filter page; the agent
> is the entire user-facing interface."

Type the first query (below) and let it run. Read the title of the top result
aloud.

> "That's a real past DASH project. The researcher could click through to
> the rendered report on GitHub Pages and see the full analysis."

(Optional, if time and you want to demonstrate the click-through: open the
report URL on the top result. Close it and return to the search.)

### Beat 2: "It's semantic, not keyword"

This is the headline. Run the next two queries in sequence.

> "The interesting thing about the matching: this query doesn't contain any of
> the exact words from the project's metadata. The system understands that
> 'X' and 'Y' mean similar things."

For each query, point out: the searcher's vocabulary, the project's vocabulary,
and the fact that they're semantically related but lexically different.

The "near miss" example is also useful — a query that returns projects that
are *related but not exact*, to show that the ranking is meaningful rather
than binary.

### Beat 3: "Adding new projects"

Switch to your editor or terminal. Open `.github/workflows/ingest-catalog.yml`.

> "When an analyst finishes a project, they push their metadata as a JSON
> file to the catalog repo. This workflow fires on push, diffs against the
> previous commit to find what changed, and POSTs each changed JSON to the
> Worker's ingest endpoint. The endpoint validates against our schema,
> generates the embedding via Cloudflare AI, and upserts into Atlas. The
> project is searchable within about a minute of the merge."

(Optional, if you want to show the actual flow without firing it: open
`option_b/projects/A01.json` and walk through the schema, then point at the
ingest endpoint in `option_b/api/ingest.js`.)

Close with:

> "That's the whole loop. Researcher types, agent retrieves. Analyst pushes,
> system ingests. The architecture has six services; only one is something
> we operate ourselves."

---

## Sample queries

Each query below has been verified against the ten illustrative projects. The
first three should be the headline queries in the demo. The rest are useful
if a supervisor asks "what else can it find?" or if you want backups.

### Headline queries

**Q1. `What past work has DASH done on skin biopsy proteomics?`**

- Should top-rank: **A01** — *Proteomic profiling of a chronic inflammatory
  skin condition*
- Why it shows off semantic search: the query says "skin biopsy"; the project
  metadata says "inflammatory skin condition" and the data modality is
  "mass spectrometry." The vector understands these describe the same kind
  of work.

**Q2. `Have we analysed brain scans in dementia or Alzheimer's research?`**

- Should top-rank: **A09** — *Imaging-based analysis of a neurodegenerative-
  disease cohort*
- Why it shows off semantic search: the query uses "brain scans" and
  "dementia / Alzheimer's"; the project says "imaging, MRI" and
  "neurodegenerative disease." No literal word overlap; the meaning matches.

**Q3. `I'm planning a study with multiple omics layers and want to find
biomarkers.`**

- Should top-rank: **A04** — *Multi-omics biomarker discovery in an endocrine
  disease*
- Why it shows off semantic search: this is a natural-language description of
  a research goal, not a keyword set. The system extracts the intent
  ("multi-omics + biomarkers") and finds the project most aligned with it.

### Backup queries (use if asked, or to fill time)

**Q4. `Looking for previous work on gut microbes in IBD.`**

- Should top-rank: **A10** — *16S microbiome analysis in an inflammatory
  bowel condition*

**Q5. `Any prior work on T-cell profiling in autoimmune disease?`**

- Should top-rank: **A06** — *Mass-cytometry immune profiling in an
  autoimmune condition*

**Q6. `Tumor microenvironment, spatial profiling of cancer.`**

- Should top-rank: **A03** — *Spatial transcriptomics of a solid-tumour
  microenvironment*

**Q7. `Long-term cardiac risk modelling in a cohort study.`**

- Should top-rank: **A07** — *Longitudinal cohort analysis of a cardiovascular
  marker*

**Q8. `Developmental biology with single cells.`**

- Should top-rank: **A05** — *Single-cell RNA-seq of a developing tissue*

---

## Talking points (one per architecture piece)

If the supervisor asks "how does this actually work?", these are the
one-sentence answers per component.

| When they ask about... | Say something like... |
|---|---|
| The web page | "A static frontend; researchers see only a search box. It calls our Worker for results." |
| The server | "A Cloudflare Worker running at the Sydney edge. Stateless, serverless, free at our query volume." |
| The database | "MongoDB Atlas in Sydney. Holds the project metadata and the embedding vectors. Backups and failover are handled for us." |
| The embedding model | "A small open-source model on Cloudflare Workers AI. Turns the researcher's question into a vector that captures its meaning." |
| The vector search | "Atlas runs vector similarity against every project's stored vector and returns the top matches. Sub-50ms at our scale." |
| Adding new projects | "An analyst pushes a JSON file to the catalog repo on GitHub. A workflow validates, embeds, and writes to Atlas. Less than a minute." |
| Cost | "About $20 to $30 per month at 1,000 projects. Atlas is the only meaningfully paid line item." |
| Security and access | "Phase 1 launches public-by-default; the access framework is in the schema and activates when the first opt-out project arrives." |
| The reports themselves | "Hosted on GitHub Pages, one repo per project. The search returns the link; researchers click through to read." |

---

## Recovery: what to do if something fails live

### The frontend hangs or shows a network error

The Worker URL might be slow on a cold start (first request after idle).
Try once more from the frontend. If it still fails, fall back to the
backup terminal window and run the smoke test:

```
option_b/scripts/smoke.sh https://<worker-url>
```

If `smoke.sh` passes, the backend is healthy and the issue is a frontend or
network glitch. Say: "Let me run that against the backend directly." Paste
the curl version of the same query into your terminal and read the JSON
title aloud. The audience won't mind a brief detour through the terminal
if you frame it as showing the underlying API.

If `smoke.sh` fails, switch narrative: "The system is built. Let me walk
through the architecture and the GitHub workflow on the way, and we'll
come back to a live query at the end." Spend the saved time on Beat 3
and the talking-points table.

### A specific search returns nothing or a wrong-looking result

Don't argue with it. Move on to the next sample query. After the demo,
add the missing pattern to the project's keywords or summary in the
catalog and re-push; the workflow will re-embed.

### A supervisor asks something the architecture doesn't yet handle

The honest answer is usually some version of: "That's a Phase 2 question.
We deliberately scoped Phase 1 to public-by-default with no authentication
so we could ship in weeks, not months. [Specific thing they asked about]
is on the roadmap once we have the first opt-out project."

The three things most likely to come up:

- **Authentication / SSO with Unikey.** "Phase 2. Triggered by the first
  opt-out project."
- **Editing metadata without GitHub.** "Phase 2. We'd add a small admin UI
  that opens a PR on the analyst's behalf."
- **Long-term archival once GitHub repos roll off.** "Phase 2. The plan is
  to mirror reports to USyd's Research Data Store before the 5-year
  retention window closes."

---

## Post-demo checklist

```
[ ] Capture any questions you couldn't answer with a clean reference back
    to the deck or the codebase
[ ] Note any sample query that returned a surprising result; treat as a
    signal about embedding quality
[ ] If anything failed, file a follow-up; do not ship the fix tonight
    while the result is still in your head
```
