# Architecture (Option B)

## Components

- **Browser** (`index.html`, `web/*.js`) — UI, identical shape to option_a. No data lives here beyond rendered results.
- **Cloudflare Worker** (`api/*.js`) — single egress point. Embeds queries via Workers AI, talks to Atlas via Data API. Replaces option_a's static `index.json` + the standalone embed-query Worker.
- **MongoDB Atlas** — `dash.projects` (with vectors), `dash.search_logs`, indexes per `atlas/`.
- **Asana** — out of scope for this mockup. Production: scheduled sync writes tags into `dash.projects`.

## Dataflow: a search query

1. User types in `#q`. Frontend calls `POST /api/search { query, filters }` with `x-demo-user` header.
2. Worker resolves user → identity object (`{ id, tier, roles }`).
3. Worker calls Workers AI to embed the query → 1024-dim vector.
4. Worker constructs aggregation pipeline:
   - `$vectorSearch` on `embedding.vector` with structured filters AND ACL filter merged into the `filter` slot.
   - `$set` to attach the similarity score.
   - `$project` to strip `embedding.vector` from results.
5. Worker calls Atlas Data API, gets ranked projects.
6. Worker fires `insertOne` on `search_logs` with the query, filters, user_id, n_results.
7. Worker returns `{ results }` to browser. Browser renders.

## What option_a does in steps 3-5

- Loads all projects + vectors into the browser (`index.json`).
- Embeds the query via the same Workers AI endpoint.
- Computes cosine similarity in JS over the in-memory array.
- Filters in JS.

## What option_a cannot do at any step

- Apply per-document RBAC before shipping data to the client. (Repo-level access only.)
- Log queries server-side without a separate logging system.
- Aggregate ("how many proteomics projects in 2025?") without iterating every document.
- Scale past ~hundreds of projects without the `index.json` fetch becoming painful (334KB at 10 projects already).

## Trust boundaries

- Browser ↔ Worker: CORS-locked to `ALLOWED_ORIGIN`. `x-demo-user` is a demo shortcut and would be replaced by a verified Bearer token in production.
- Worker ↔ Atlas: API key in Worker secrets. Atlas network access list pinned to known IPs in production.
- Worker ↔ Workers AI: in-process binding, no network egress.
