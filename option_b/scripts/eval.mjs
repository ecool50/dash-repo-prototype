#!/usr/bin/env node
// Retrieval eval for the DASH search API. Runs each query in eval/queries.jsonl
// against POST /api/search and scores whether the expected project(s) are
// retrieved. Deterministic: targets /api/search (embed + rerank), not the LLM
// agent, so it isolates retrieval quality. Run before and after any change to
// search.js, the abbreviation map, or the embeddings to see if it moved.
//
// Usage:
//   node scripts/eval.mjs                       # against the deployed API
//   API_BASE=http://localhost:8787 npm run eval # against a local API
//
// Metrics:
//   recall@5  — fraction of a query's expected refs found in the top 5.
//   MRR       — mean reciprocal rank of the first expected ref (positives).
//   hit@5     — fraction of positive queries with >=1 expected ref in top 5.
//   negatives — a "false positive" is a nonsense/chit-chat query that returns
//               STRONG (non-weak) results; these should return nothing (or weak).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const API_BASE = process.env.API_BASE || 'https://dash-api.ecool50.workers.dev';
const K = 5;
const FETCH_LIMIT = 10;

const here = path.dirname(fileURLToPath(import.meta.url));
const queriesPath = process.argv[2] || path.join(here, '..', 'eval', 'queries.jsonl');
const queries = fs.readFileSync(queriesPath, 'utf8')
  .split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

async function search(query, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${API_BASE}/api/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, limit: FETCH_LIMIT }),
      });
      if (res.ok) return res.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400 + i * 400));
  }
  throw new Error(`search failed for: ${query}`);
}

const norm = (r) => String(r).toLowerCase().replace(/^cpcdash/, '');

function scorePositive(expect, found) {
  const top = found.slice(0, K).map(norm);
  const want = expect.map(norm);
  const hits = want.filter((e) => top.includes(e));
  // rank (1-based) of the first expected ref anywhere in the returned list
  let firstRank = Infinity;
  found.forEach((r, i) => { if (want.includes(norm(r)) && i + 1 < firstRank) firstRank = i + 1; });
  return {
    recall: hits.length / want.length,
    rr: Number.isFinite(firstRank) ? 1 / firstRank : 0,
    hit: hits.length > 0 ? 1 : 0,
    firstRank: Number.isFinite(firstRank) ? firstRank : '-',
  };
}

const rows = [];
const agg = { pos: [], person: [], neg: [] };

for (const item of queries) {
  const { results = [], weak = false } = await search(item.q);
  const found = results.map((r) => r.ref_number);
  const bucket = item.type === 'negative' ? 'neg' : item.type === 'person' ? 'person' : 'pos';

  if (bucket === 'neg') {
    const strong = found.length > 0 && !weak;
    agg.neg.push({ falsePositive: strong });
    rows.push({ type: item.type, q: item.q, expect: '(none)', got: found.slice(0, 3).join(',') || '-', weak, ok: !strong });
  } else {
    const s = scorePositive(item.expect, found);
    (bucket === 'person' ? agg.person : agg.pos).push(s);
    rows.push({
      type: item.type, q: item.q, expect: item.expect.join(','),
      got: found.slice(0, 3).join(','), weak, rank: s.firstRank,
      recall: s.recall, ok: s.hit === 1,
    });
  }
}

const mean = (xs, f) => (xs.length ? xs.reduce((a, x) => a + f(x), 0) / xs.length : 0);
const pct = (x) => `${(x * 100).toFixed(0)}%`;

// --- report ---
console.log(`\nDASH retrieval eval  —  ${API_BASE}\n${'='.repeat(78)}`);
for (const r of rows) {
  const mark = r.ok ? ' ok ' : 'MISS';
  const extra = r.type === 'negative'
    ? `weak=${r.weak}`
    : `rank=${r.rank} recall@${K}=${pct(r.recall)}${r.weak ? ' weak' : ''}`;
  console.log(`[${mark}] ${(r.type + ']').padEnd(9)} ${r.q}`);
  console.log(`        expect=${r.expect}  got=${r.got || '-'}  ${extra}`);
}

const topical = [...agg.pos];
console.log(`\n${'-'.repeat(78)}\nSummary`);
console.log(`  Topical/method/tool (${topical.length}):  hit@${K} ${pct(mean(topical, (s) => s.hit))}   recall@${K} ${pct(mean(topical, (s) => s.recall))}   MRR ${mean(topical, (s) => s.rr).toFixed(3)}`);
console.log(`  Person (${agg.person.length}):               recall@${K} ${pct(mean(agg.person, (s) => s.recall))}   MRR ${mean(agg.person, (s) => s.rr).toFixed(3)}`);
const fpr = mean(agg.neg, (x) => (x.falsePositive ? 1 : 0));
console.log(`  Negatives (${agg.neg.length}):            false-positive ${pct(fpr)}  (lower is better)`);
const allPos = [...agg.pos, ...agg.person];
console.log(`  Weak-rate on positives:     ${pct(mean(rows.filter((r) => r.type !== 'negative'), (r) => (r.weak ? 1 : 0)))}`);
console.log(`  Overall hit@${K} (pos+person): ${pct(mean(allPos, (s) => s.hit))}\n`);
