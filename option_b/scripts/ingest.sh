#!/usr/bin/env bash
# Ingest every project JSON into the deployed Worker's /api/ingest endpoint.
#
# The Worker validates, (re)embeds via Workers AI, and upserts into Atlas.
# Ingest is idempotent and the Worker skips re-embedding when a project's
# source_text is unchanged, so re-POSTing the whole catalog every run is
# cheap: only genuinely changed projects cost a Workers AI call. That is why
# this script does not bother detecting which files changed.
#
# This is the manual replacement for the ingest-catalog GitHub Action on a
# GitHub Enterprise Server host, where Actions are disabled.
#
# Usage:
#   INGEST_URL=https://dash-api.<sub>.workers.dev \
#   INGEST_SECRET=<token> \
#   option_b/scripts/ingest.sh
#
# Dependencies: bash, curl.

set -uo pipefail

: "${INGEST_URL:?Set INGEST_URL to the Worker base URL}"
: "${INGEST_SECRET:?Set INGEST_SECRET to the Worker bearer token}"

# Resolve projects/ relative to this script (scripts/ is a sibling of projects/).
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
projects_dir="$here/projects"
url="${INGEST_URL%/}/api/ingest"

shopt -s nullglob
files=("$projects_dir"/*.json)
if [ ${#files[@]} -eq 0 ]; then
  echo "No project JSONs found in $projects_dir" >&2
  exit 1
fi

ok=0; fail=0
for f in "${files[@]}"; do
  printf 'POST %s ... ' "$(basename "$f")"
  resp="$(curl -sS -w $'\n%{http_code}' \
    -X POST "$url" \
    -H "authorization: Bearer $INGEST_SECRET" \
    -H 'content-type: application/json' \
    --data-binary @"$f" 2>&1)"
  status="$(printf '%s' "$resp" | tail -n1)"
  body="$(printf '%s' "$resp" | sed '$d')"
  if [[ "$status" =~ ^2 ]]; then
    echo "ok ($status) $body"
    ok=$((ok + 1))
  else
    echo "FAIL ($status) $body"
    fail=$((fail + 1))
  fi
done

echo "Ingested $ok, failed $fail."
[ "$fail" -eq 0 ]
