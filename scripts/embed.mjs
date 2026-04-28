#!/usr/bin/env node
// Compute embeddings for one or more project JSONs and write the vector
// back into the embedding.vector field of each file.
//
// Usage:
//   OPENAI_API_KEY=sk-... node scripts/embed.mjs projects/A01.json [...]
//
// Skips files whose source_text hasn't changed since last embed (a hash
// is stored alongside the vector in embedding._source_hash).

import fs from 'node:fs';
import crypto from 'node:crypto';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY not set.');
  process.exit(1);
}

const MODEL = 'text-embedding-3-small';
const args = process.argv.slice(2).filter(a => a.endsWith('.json'));

if (args.length === 0) {
  console.log('No files to embed.');
  process.exit(0);
}

async function embed(input) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, input }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${detail}`);
  }
  const body = await res.json();
  return body.data[0].embedding;
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
  const vector = await embed(sourceText);
  doc.embedding.model = MODEL;
  doc.embedding.vector = vector;
  doc.embedding._source_hash = h;
  doc.embedding._embedded_at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  updated++;
}

console.log(`\nUpdated ${updated} file(s).`);
