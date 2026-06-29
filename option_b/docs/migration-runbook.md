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
- **GitHub**: a FRESH repository in the existing DASH organisation, with
  a restructured layout, created and pushed from Elijah's other (non
  `ecool50`) GitHub account. No transfer, no history carried over: the
  new repo starts with clean commits under the new identity. `ecool50`
  is not used anywhere in the new setup; `ecool50/dash-repo-prototype`
  becomes a private personal archive after cutover.

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
2. **GitHub organisation: already exists.** Elijah's other GitHub
   account is (or will be) a member. That account needs permission to
   create repositories in the org, and admin on the new repo to set the
   Actions secrets. Confirm the org allows GitHub Actions on new repos.
   Capture: the org name, the account username, and the name + email to
   use for git commits (set per-repo with `git config user.name` /
   `user.email`).
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

### Note: frontend URL and naming (decide at cutover)

The public URL is `https://<worker-name>.<subdomain>.workers.dev`. Three
things are settable, in increasing effort:

- **`workers.dev` subdomain** (`ecool50` today): chosen once per account
  in Step 0.1 (suggested `cpc-dash`), giving
  `https://dash-frontend.cpc-dash.workers.dev`. Account-wide, so it also
  renames the API Worker's URL.
- **Worker name** (`dash-frontend` today): the `name` field in
  `dash_frontend/wrangler.toml`. Rename here if a shorter name is wanted
  (e.g. `dash` → `https://dash.cpc-dash.workers.dev`).
- **Custom domain** (optional, post-cutover): attach a USyd subdomain
  such as `dash.cpc.sydney.edu.au` to the frontend Worker in Cloudflare.
  Needs DNS delegation from USyd IT, so treat as a follow-up, not a
  cutover blocker.

No specific name is chosen yet (**TBD**). Whatever the frontend URL ends
up as, update two things in lockstep: the first entry of `ALLOWED_ORIGIN`
in `option_b/api/wrangler.toml` (CORS), and `VITE_API_BASE_URL` in
`dash_frontend/.env.production` if the API URL changed too.

## Step 4: create the fresh repository in the DASH org

1. **Restructure locally first.** Build the new tree in a new local
   directory (proposed layout below), init a fresh git repo, and set the
   per-repo identity to the new account BEFORE the first commit:
   ```sh
   git config user.name  "<new name>"
   git config user.email "<new email>"
   ```
   Proposed layout (drops option_a, the static index.html mockup, and
   web/; flattens option_b):
   ```
   api/          <- option_b/api        (Worker)
   frontend/     <- dash_frontend       (React + Vite SPA)
   projects/     <- option_b/projects   (catalog JSONs)
   atlas/        <- option_b/atlas      (index specs)
   scripts/      <- option_b/scripts
   docs/         <- option_b/docs
   schema_v1.json
   .github/workflows/
   ```
2. **Update the workflow paths** for the new layout: `deploy-worker.yml`
   (`option_b/api` becomes `api`) and `ingest-catalog.yml`
   (`option_b/projects` becomes `projects`). Grep docs and scripts for
   `option_b/` and `dash_frontend/` references too.
3. Create an empty repo in the DASH org from the new account (suggested
   name: `dash-repository`), add it as `origin`, push.
4. In the new repo: Settings → Secrets and variables → Actions, set all
   four:
   | Secret | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | token created on the DASH Cloudflare account |
   | `CLOUDFLARE_ACCOUNT_ID` | DASH Cloudflare account ID |
   | `INGEST_URL` | new API Worker base URL |
   | `INGEST_SECRET` | the new secret from step 3 |
5. Auth note: `gh` on this machine is logged in as `ecool50`. Use
   `gh auth login` to add the new account (or SSH keys scoped to it)
   before pushing, and check `gh auth status` shows the new account as
   active for github.com.

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
4. Make `ecool50/dash-repo-prototype` private (Settings → General →
   Danger Zone → Change visibility). It stays as a personal archive;
   disable its Actions workflows or delete the repo secrets so nothing
   can fire against decommissioned infrastructure.

## Things that intentionally do not change

- No code changes are required beyond the two URL strings
  (`dash_frontend/.env.production` and the `ALLOWED_ORIGIN` allowlist).
- Workers are stateless; all persistent state moves with Atlas.
- The workflow files are repo-local and survive the transfer untouched.
