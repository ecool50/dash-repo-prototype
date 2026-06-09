# Option B: MongoDB-backed mockup — proposed layout

This document sketches the directory layout for a sibling mockup (`option_b/`) that replaces the static `index.json` + client-side filtering of option_a with MongoDB Atlas as the query backend. It exists so the structural shape can be reviewed before any code is written.

## Goals

- Demonstrate `$vectorSearch` server-side instead of shipping vectors to the browser.
- Show document-level RBAC at query time (the headline capability gap vs option_a).
- Demonstrate query logging and structured aggregations that option_a can't do.
- Keep the deployment story unchanged: Cloudflare Worker + static site on GitHub Pages, Atlas behind the Worker.

## Directory tree

```
option_b/
├── README.md                          [NEW]     What this is, how it differs from option_a
├── index.html                         [CHANGED] Same UI as option_a; fetches /api/* instead of index.json
├── schema_v1.json                     [SAME]    Copy of option_a's schema
│
├── projects/                          [SAME]    Seed data, copies of option_a/projects/*.json
│   ├── A01.json
│   └── ... A10.json
│
├── atlas/                             [NEW]     Atlas config-as-code so setup is reproducible
│   ├── vector-index.json              Vector search index spec for embedding.vector
│   ├── search-indexes.json            Atlas Search index for full-text on title + summary
│   ├── compound-indexes.json          Multikey indexes (tags, modality, disease, status)
│   └── README.md                      Steps to apply via Atlas CLI / API
│
├── api/                               [NEW]     Replaces option_a's static index.json with a query API
│   ├── worker.js                      Cloudflare Worker entry: routes /api/search, /api/projects/:id, /api/query-embed
│   ├── search.js                      Builds $vectorSearch + $match pipeline; runs aggregation
│   ├── rbac.js                        Filters projects by viewer ACL; injected into $match at query time
│   ├── auth.js                        Token → user_id resolver (fake JWT or signed cookie for demo)
│   ├── mongo.js                       Atlas Data API or driver-over-HTTP client wrapper
│   └── wrangler.toml                  Worker config: ATLAS_URI secret, ALLOWED_ORIGIN, AI binding
│
├── scripts/                           [MOSTLY-NEW]
│   ├── ingest.mjs                     [NEW]     Read projects/*.json → upsert into Atlas (one-shot or on data change)
│   ├── embed.mjs                      [CHANGED] Same as option_a but writes vectors to Mongo, not back to JSON
│   ├── validate.mjs                   [SAME]    Schema validation, unchanged
│   └── seed-acls.mjs                  [NEW]     Populates access.viewers on each project for RBAC demo
│
├── web/                               [NEW]     Extracted from option_a's inline JS for clarity
│   ├── app.js                         Frontend logic: API calls, render, user-picker
│   ├── api-client.js                  Thin wrapper over /api/* endpoints
│   └── style.css                      Optional extract; option_a keeps style inline
│
└── docs/
    ├── setup.md                       [NEW]     Atlas cluster → indexes → worker deploy → ingest → demo
    ├── rbac-demo.md                   [NEW]     How the user-picker drives doc-level filtering
    └── architecture.md                [NEW]     Dataflow diagram, parallel to option_a's implicit one
```

## Rationale

### Parallels option_a where it can

`projects/`, `schema_v1.json`, and `validate.mjs` are unchanged so reviewers can diff the two options cleanly. The interesting differences cluster in `api/` and `atlas/`. Anything that didn't need to change, didn't.

### Separates config from code

`atlas/` holds index specs as JSON; `api/` holds the Worker. This is a meaningful structural improvement over option_a, where the entire system fits in one HTML file plus one Worker — but it's also necessary, because Mongo's setup is no longer trivial and needs to be reproducible across environments.

### Makes RBAC first-class

`rbac.js`, `auth.js`, `seed-acls.mjs`, and `docs/rbac-demo.md` exist specifically so a demo viewer can flip between users and watch the result set change. This is the headline difference vs option_a and earns its own files rather than living as a flag inside one search function.

### Keeps the Worker-based deployment

Deploy story remains "Cloudflare Worker + static site on GitHub Pages," with Atlas behind the Worker. No new hosting platform, no new build pipeline, no new auth provider for the demo. The Worker that already exists in option_a (`workers/embed-query.js`) gets folded into option_b's `api/worker.js` as the `/api/query-embed` route.

## Two layout choices flagged for review

### `api/` as one file vs split

The split shown (`worker.js`, `search.js`, `rbac.js`, `auth.js`, `mongo.js`) is ~5 short files that mirror option_a's clarity. A single file would be fewer moving parts but harder to point at in a proposal ("here's the RBAC code, in 30 lines"). The recommendation is to keep the split.

### `web/` extraction

Option_a inlines all JS in `index.html` (88KB). Option_b will likely grow past comfortable inline size once user-picker + paginated results + RBAC indicators are added. Extracting now is cheap; doing it later is annoying.

## Estimated file counts

- ~4 new code files in `api/` (~600 lines total)
- ~3 new scripts (~250 lines)
- ~3 Atlas config JSONs (~150 lines, mostly schema)
- 3 docs files
- `index.html` shrinks slightly as logic moves into `web/app.js`

## Effort estimate

Roughly 2 dev-days for parity with option_a (same UI, same data, Mongo-backed). Roughly 3 days if the doc-level RBAC demo and query-logging story are also implemented — and they should be, because without them the side-by-side comparison looks like "same UI, different backend" and the case for switching is invisible to reviewers.

## What this layout does *not* commit to

- Whether the Worker uses Atlas Data API (HTTP) or a driver-over-HTTP client. Either fits; pick during implementation based on which is current at build time.
- Whether `web/style.css` is actually extracted, or remains inline like option_a.
- Whether `seed-acls.mjs` lives separately or is folded into `ingest.mjs` with a `--with-acls` flag.

These are implementation details that don't affect the structural shape of the comparison.
