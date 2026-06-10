# Migration runbook: moving the mockup to DASH-owned infrastructure

Status: **preparation phase**. Nothing exists on the DASH side yet. This
runbook tracks the move from the current personal-account deployment to
DASH-owned accounts. The companion reference is section 8 of
`setup-walkthrough.pdf`; this file is the working checklist with the
decisions filled in.

## Decisions made

- **Atlas**: Option B, a fresh DASH-owned Atlas project and cluster, with
  data copied across via `mongodump` / `mongorestore`. Chosen for clean
  separation from the personal account.
- **Cloudflare**: new DASH-owned account (no institutional team access
  identified yet).
- **GitHub**: repo transfer to a DASH organisation once it exists.

## Current deployment (the "from" side)

| Component | Where it lives today |
|---|---|
| Frontend | `https://dash-frontend.ecool50.workers.dev` |
| API Worker | `https://dash-api.ecool50.workers.dev` |
| Database | MongoDB Atlas Flex, `ap-southeast-2` (Sydney), personal account |
| Repo | `github.com/ecool50/dash-repo-prototype` |

## Step 0: create the DASH accounts (Elijah, blocking)

Elijah is creating the accounts. Use a DASH role email rather than a
personal one where possible, so ownership survives staff changes.
Nothing else in this runbook can start until these exist.

1. **Cloudflare account.** Sign up, then Workers and Pages → enable the
   `workers.dev` subdomain (pick something like `cpc-dash`). The free
   plan covers current usage; Workers AI (embeddings via
   `bge-large-en-v1.5`) bills per request to this account.
   Capture: the account email, the **Account ID** (dashboard right
   sidebar), and the chosen `workers.dev` subdomain.
2. **GitHub organisation** (e.g. `CPC-DASH`), free plan. Add Elijah's
   personal account (`ecool50`) as an owner so the repo transfer and CI
   administration work.
   Capture: the org name.
3. **MongoDB Atlas organisation + project.** Create the org, a project
   (e.g. `dash-repository`), then a **Flex** cluster on AWS in
   `ap-southeast-2` (Sydney). Same tier as today; roughly USD 8-30/month
   depending on usage. Database Access → add a user with readWrite on
   the `dash` database only. Network Access → allow `0.0.0.0/0` (Workers
   have no stable egress IPs).
   Capture: the account email and the **connection string** for the new
   user.

Still to resolve with supervisors: who pays long-term (JMRF grant line),
and whether the accounts should later move to role emails if personal
ones are used now.

## Step 1: pre-migration cleanup (local, done)

Completed locally on 2026-06-11, **not yet pushed**:

- [x] CORS tightened from `*` to an origin allowlist
  (`option_b/api/wrangler.toml` + `worker.js`). The first allowlist entry
  must be updated to the new frontend URL at cutover.
- [x] `dash_frontend/package-lock.json` committed for reproducible builds.
- [x] A01-A02 and A04-A10 JSONs touched so the next push re-ingests them,
  replacing the stale pre-migration `access` shape still in Atlas.
- [ ] **Push to main** (fires `deploy-worker` and `ingest-catalog`), then
  verify: CI green, `GET /api/projects/A01` shows the new `access` block,
  frontend still searches.

## Step 2: stand up the new Atlas cluster

1. In the DASH Atlas project, create the Flex cluster in `ap-southeast-2`.
2. Create a database user for the Worker (least privilege: readWrite on
   the `dash` database only).
3. Network access: allow `0.0.0.0/0` (Workers have no stable egress IPs);
   security is in the credential, same as today.
4. Copy the data:
   ```sh
   mongodump  --uri "$OLD_ATLAS_URI" --db dash
   mongorestore --uri "$NEW_ATLAS_URI" --nsInclude 'dash.*' dump/
   ```
5. **Recreate the three search indexes by hand.** `mongodump` does NOT
   carry Atlas Search or Vector Search indexes. Apply the JSON specs from
   `option_b/atlas/` (vector-index.json, compound-indexes.json,
   search-indexes.json) exactly as in section 3.4 of the walkthrough.
6. Sanity check: document count in `dash.projects` matches the old
   cluster, and a manual vector search in the Atlas UI returns results.

## Step 3: deploy the Workers on the DASH Cloudflare account

From a machine logged in to the new account (`npx wrangler login`):

1. API Worker, from `option_b/api/`:
   ```sh
   npx wrangler secret put ATLAS_URI      # new cluster connection string
   npx wrangler secret put INGEST_SECRET  # generate a NEW one; do not reuse
   npx wrangler deploy
   ```
   Note the new URL (`https://dash-api.<new-subdomain>.workers.dev`).
2. Frontend, from `dash_frontend/`:
   - Update `.env.production` with the new API URL.
   - Update the first entry of `ALLOWED_ORIGIN` in
     `option_b/api/wrangler.toml` to the new frontend URL, redeploy the
     API Worker.
   - `npm ci && npm run build && npx wrangler deploy`.
3. Smoke test against the new URLs (walkthrough section 7.5).

## Step 4: transfer the GitHub repository

1. Repo Settings → General → Transfer ownership → the DASH org.
   History, branches, and workflow files all move; **Actions secrets do
   not**.
2. In the new repo: Settings → Secrets and variables → Actions, set all
   four:
   | Secret | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | token created on the DASH Cloudflare account |
   | `CLOUDFLARE_ACCOUNT_ID` | DASH Cloudflare account ID |
   | `INGEST_URL` | new API Worker base URL |
   | `INGEST_SECRET` | the new secret from step 3 |
3. Update the local remote: `git remote set-url origin <new-url>`.

## Step 5: verify and cut over

1. Push a trivial commit touching one project JSON; confirm both
   workflows go green and the change lands in the new Atlas cluster.
2. Run the full smoke test against the new frontend.
3. Share the new frontend URL with the team.

## Step 6: decommission the old deployment

Only after step 5 is verified:

1. Delete `dash-api` and `dash-frontend` Workers from the personal
   Cloudflare account.
2. Terminate the old Atlas cluster (export a final `mongodump` archive
   first, kept locally as a belt-and-braces backup).
3. Revoke the old Cloudflare API token and the old `INGEST_SECRET`.

## Things that intentionally do not change

- No code changes are required beyond the two URL strings
  (`dash_frontend/.env.production` and the `ALLOWED_ORIGIN` allowlist).
- Workers are stateless; all persistent state moves with Atlas.
- The workflow files are repo-local and survive the transfer untouched.
