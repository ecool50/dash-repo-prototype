#!/usr/bin/env bash
# One-command publish: push to the repo (GHES), then ingest the catalog.
#
# On a GitHub Enterprise Server host there is no Actions runner to ingest on
# push, so this wrapper does both: it pushes (the source of truth) and, only
# if the push succeeds, re-ingests the catalog into the Worker/Atlas. Use it
# in place of `git push` whenever you have changed project JSONs.
#
# Worker or frontend CODE changes are NOT handled here (they need wrangler).
# After a code change, deploy separately with `npm run wrangler:deploy`.
#
# Usage (INGEST_URL / INGEST_SECRET in the environment):
#   INGEST_URL=... INGEST_SECRET=... option_b/scripts/publish.sh [git push args]

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

git push "$@"
"$here/ingest.sh"
