#!/usr/bin/env bash
# Smoke test for the DASH Worker.
#
# Hits each of the four endpoints against a configurable base URL and
# prints PASS/FAIL per check. Exits non-zero if any check fails.
#
# Usage:
#   BASE_URL=https://dash-api.<sub>.workers.dev \
#   INGEST_SECRET=<token> \
#   option_b/scripts/smoke.sh
#
# Or with positional first arg:
#   option_b/scripts/smoke.sh https://dash-api.<sub>.workers.dev
#
# Optional:
#   TEST_REF        ref_number to fetch in the project-by-id test (default A01)
#   INGEST_SECRET   when set, runs the ingest endpoint authorization tests
#
# Dependencies: bash, curl. jq is used if present but not required.

set -uo pipefail

BASE_URL="${1:-${BASE_URL:-}}"
TEST_REF="${TEST_REF:-A01}"

if [[ -z "$BASE_URL" ]]; then
  echo "Set BASE_URL or pass the worker URL as the first argument." >&2
  echo "Example: option_b/scripts/smoke.sh https://dash-api.ecool50.workers.dev" >&2
  exit 2
fi

# Strip trailing slash.
BASE_URL="${BASE_URL%/}"

pass=0
fail=0

# ---- helpers -----------------------------------------------------------------

pretty() {
  if command -v jq >/dev/null 2>&1; then
    jq . 2>/dev/null || cat
  else
    cat
  fi
}

check() {
  local label="$1"; shift
  local expected_status="$1"; shift
  local response status body
  response="$("$@" -s -w $'\n%{http_code}')"
  status="$(echo "$response" | tail -n1)"
  body="$(echo "$response" | sed '$d')"

  if [[ "$status" == "$expected_status" ]]; then
    echo "PASS  [$status]  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  [$status, expected $expected_status]  $label"
    echo "$body" | pretty | sed 's/^/      /'
    fail=$((fail + 1))
  fi
}

probe() {
  # Same as check but always prints the body summary line (for read endpoints
  # we want to confirm the shape looks right even on PASS).
  local label="$1"; shift
  local expected_status="$1"; shift
  local response status body
  response="$("$@" -s -w $'\n%{http_code}')"
  status="$(echo "$response" | tail -n1)"
  body="$(echo "$response" | sed '$d')"

  if [[ "$status" == "$expected_status" ]]; then
    echo "PASS  [$status]  $label"
    if command -v jq >/dev/null 2>&1; then
      echo "$body" | jq -c '
        if has("results") then "results: \(.results | length) project(s)"
        elif has("vector") then "vector: \(.dimensions) dims, model=\(.model)"
        elif has("ref_number") then "ref=\(.ref_number) title=\(.title // "n/a")"
        else "ok"
        end
      ' 2>/dev/null | sed 's/^/      /'
    fi
    pass=$((pass + 1))
  else
    echo "FAIL  [$status, expected $expected_status]  $label"
    echo "$body" | pretty | sed 's/^/      /'
    fail=$((fail + 1))
  fi
}

echo "Base: $BASE_URL"
echo "Ref:  $TEST_REF"
echo

# ---- 1. query-embed ----------------------------------------------------------

probe "POST /api/query-embed" 200 \
  curl -X POST "$BASE_URL/api/query-embed" \
    -H 'content-type: application/json' \
    --data '{"query":"skin biopsy proteomics"}'

# ---- 2. search ---------------------------------------------------------------

probe "POST /api/search (natural-language query)" 200 \
  curl -X POST "$BASE_URL/api/search" \
    -H 'content-type: application/json' \
    --data '{"query":"inflammatory skin proteomics","limit":3}'

# ---- 3. project-by-id --------------------------------------------------------

probe "GET /api/projects/$TEST_REF" 200 \
  curl "$BASE_URL/api/projects/$TEST_REF"

# ---- 4. not-found ------------------------------------------------------------

check "GET /api/nope (expect 404)" 404 \
  curl "$BASE_URL/api/nope"

# ---- 5. ingest auth checks ---------------------------------------------------

check "POST /api/ingest no auth (expect 401)" 401 \
  curl -X POST "$BASE_URL/api/ingest" \
    -H 'content-type: application/json' \
    --data '{}'

check "POST /api/ingest wrong secret (expect 401)" 401 \
  curl -X POST "$BASE_URL/api/ingest" \
    -H 'content-type: application/json' \
    -H 'authorization: Bearer this-is-not-the-secret' \
    --data '{}'

if [[ -n "${INGEST_SECRET:-}" ]]; then
  # With a valid secret, an empty body should return 500 with a "ref_number" error
  # (auth passed; validation failed). We assert 500 rather than 400 since the
  # Worker reports validation failures as caught exceptions.
  check "POST /api/ingest valid secret, empty body (expect 500)" 500 \
    curl -X POST "$BASE_URL/api/ingest" \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $INGEST_SECRET" \
      --data '{}'
else
  echo "SKIP  POST /api/ingest valid secret (set INGEST_SECRET to enable)"
fi

# ---- summary -----------------------------------------------------------------

echo
echo "Passed: $pass  Failed: $fail"
exit $(( fail > 0 ? 1 : 0 ))
