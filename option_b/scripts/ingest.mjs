#!/usr/bin/env node
// Ingest projects/*.json into MongoDB Atlas as the `dash.projects` collection.
//
// Required env:
//   ATLAS_URI  mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority
//
// Usage:
//   ATLAS_URI=... node scripts/ingest.mjs projects/*.json
//
// Idempotent: upserts on ref_number.

import fs from 'node:fs';
import { MongoClient } from 'mongodb';

const { ATLAS_URI } = process.env;
if (!ATLAS_URI) { console.error('ATLAS_URI not set'); process.exit(1); }

const args = process.argv.slice(2).filter((a) => a.endsWith('.json'));
if (!args.length) { console.log('No files.'); process.exit(0); }

const mc = new MongoClient(ATLAS_URI);
await mc.connect();
const projects = mc.db('dash').collection('projects');

let n = 0;
for (const file of args) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc.ref_number) { console.warn(`SKIP ${file}: no ref_number`); continue; }
  await projects.updateOne(
    { ref_number: doc.ref_number },
    { $set: doc },
    { upsert: true }
  );
  console.log(`UPSERT ${file} (ref_number=${doc.ref_number})`);
  n++;
}

console.log(`\nIngested ${n} document(s).`);
await mc.close();
