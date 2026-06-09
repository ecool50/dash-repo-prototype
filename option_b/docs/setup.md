# Setup — running locally (Path 2)

This walks you from zero to a working option_b on `http://localhost:8787` against a real MongoDB Atlas cluster.

The Cloudflare Worker in `api/` is the documented production target. For local development, this guide uses `scripts/dev-server.mjs` — a plain Node HTTP server that talks to the same Atlas cluster. It exists because the `mongodb` driver bundle exceeds Workers' free-tier size budget and Atlas Data API has been deprecated.

## Step 1 — Atlas signup and cluster (one-time, ~15 min)

You do this part in the browser at https://www.mongodb.com/cloud/atlas.

1. Sign up (free, no credit card needed).
2. Create a new project, e.g. `DASH demo`.
3. Build a cluster: pick **M0 (free)**, any region.
4. Wait for it to provision (~3 min).
5. **Database access**: create a database user (username + password). Note these.
6. **Network access**: add IP `0.0.0.0/0` (allow from anywhere) for the demo. In production, restrict.
7. **Connect** → "Drivers" → Node.js → copy the `mongodb+srv://...` URI. Replace `<password>` with the real one. This is your `ATLAS_URI`.

## Step 2 — Create the database, collection, and indexes

In the Atlas UI, open the cluster → "Browse Collections" → "Add My Own Data".

- Database: `dash`
- Collection: `projects`

Now apply the indexes from `option_b/atlas/`. There are three.

### 2a. Compound indexes (regular)

Atlas UI → cluster → "Browse Collections" → `dash.projects` → Indexes tab → Create Index. Repeat for each entry in `atlas/compound-indexes.json`. Or run them via `mongosh` (Atlas UI → "Connect" → "mongosh"):

```
use dash
db.projects.createIndex({ ref_number: 1 }, { unique: true })
db.projects.createIndex({ "tags.asana_tags": 1 })
db.projects.createIndex({ "tags.method_tags": 1 })
db.projects.createIndex({ "project_details.data_modality": 1 })
db.projects.createIndex({ "project_details.disease": 1 })
db.projects.createIndex({ status: 1 })
db.projects.createIndex({ updated_at: -1, status: 1 })
db.projects.createIndex({ "access.viewers": 1 })
```

### 2b. Vector search index

Atlas UI → cluster → "Search" tab → "Create Search Index" → "Atlas Vector Search" → "JSON Editor". Database: `dash`, collection: `projects`. Paste the `definition` block from `atlas/vector-index.json`. Index name: `projects_vector`.

### 2c. Atlas Search index (full-text)

Same flow, "Atlas Search" instead of vector. Paste the `definition` block from `atlas/search-indexes.json`. Index name: `projects_text`.

(2c is optional for the demo — the vector index alone is enough to see RBAC + semantic search work. Skip if you're impatient.)

## Step 3 — Local prep (~2 min)

You're back in the terminal.

```
cd option_b
npm install   # already done if you ran the scaffold
```

Embed the seed projects (uses your existing dash-embed-query Worker):

```
EMBED_URL=https://dash-embed-query.ecool50.workers.dev npm run embed
```

Seed the access lists:

```
npm run seed-acls
```

## Step 4 — Ingest into Atlas (~1 min)

```
ATLAS_URI='mongodb+srv://USER:PASS@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority' npm run ingest
```

You should see `UPSERT projects/A01.json (ref_number=A01)` for each of the 10 projects.

## Step 5 — Start the dev server

```
ATLAS_URI='mongodb+srv://...' npm run dev
```

You should see:

```
Connected to Atlas. Listening on http://localhost:8787
```

## Step 6 — Open the frontend

```
open option_b/index.html
```

Type a query. Switch the user-picker. Watch the result set change as the database-side ACL filter kicks in.

## Troubleshooting

- **`ENOTFOUND` on Atlas URI**: your IP isn't on the network access list, or the URI is wrong.
- **Empty results for analyst user too**: `npm run ingest` didn't run, or the vector index hasn't finished building (Atlas takes ~1 min after creation).
- **Vector search errors**: check the index name in Atlas matches `projects_vector` exactly, and dimensions are 1024.
- **CORS errors in browser**: open `index.html` from `file://` is fine for the demo; the dev server allows `*`.

## Production deploy (later)

When you're ready, the Worker in `api/` is the production target:

```
cd api
npx wrangler login
npx wrangler secret put ATLAS_URI
npx wrangler deploy
```

Note the bundle-size caveat above — you may need a paid Workers plan, or to switch to Atlas Data API if MongoDB ever brings it back, or to a small managed Node host (Fly, Render).
