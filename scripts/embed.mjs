#!/usr/bin/env node
// Compute embeddings for one or more project JSONs via the deployed
// Cloudflare Worker, then write the vector back into embedding.vector.
//
// Usage:
//   EMBED_URL=https://dash-embed-query.<sub>.workers.dev \
//   node scripts/embed.mjs projects/A01.json [...]
//
// Skips files whose source_text hasn't changed since the last embed
// (a hash is stored in embedding._source_hash). The Worker uses the
// same model for both build-time and query-time embeddings, so vectors
// are directly comparable.

import fs from 'node:fs';
import crypto from 'node:crypto';

const EMBED_URL = process.env.EMBED_URL || 'https://dash-embed-query.ecool50.workers.dev';
const args = process.argv.slice(2).filter(a => a.endsWith('.json'));

if (args.length === 0) {
  console.log('No files to embed.');
  process.exit(0);
}

async function embed(input) {
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: input }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Worker ${res.status}: ${detail}`);
  }
  return res.json();
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

let updated = 0;
for (const file of args) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sourceText = doc?.embedding?.source_text;
  if (!sourceText) {
    console.warn(`SKIP ${file}: no embedding.source_text`);
    continue;
  }
  const h = hash(sourceText);
  if (doc.embedding._source_hash === h && Array.isArray(doc.embedding.vector)) {
    console.log(`SKIP ${file}: source_text unchanged`);
    continue;
  }
  console.log(`EMBED ${file}...`);
  const { model, vector } = await embed(sourceText);
  doc.embedding.model = model;
  doc.embedding.vector = vector;
  doc.embedding._source_hash = h;
  doc.embedding._embedded_at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  updated++;
}

console.log(`\nUpdated ${updated} file(s).`);
