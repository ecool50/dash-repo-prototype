#!/usr/bin/env node
// Validate one or more project JSON files against schema_v1.json.
// Usage:
//   node scripts/validate.mjs projects/A01.json projects/A02.json
//
// Checks: $required_fields exist, enum values valid, no extra dotted-path
// rot. Light validator — no AJV dep.

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_PATH = 'schema_v1.json';
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const required = schema.$required_fields ?? [];
const enums = schema.$enums ?? {};

const enumFor = {
  'status': enums.status,
  'access.preset': enums.access_preset,
  'access.discovery': enums.access_tier,
  'access.summary': enums.access_tier,
  'access.report_link': enums.access_tier,
  'access.code_link': enums.access_tier,
  'outputs.report_layout': enums.report_layout,
};

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function validateOne(file) {
  const errors = [];
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return [`${file}: parse error: ${e.message}`];
  }
  for (const f of required) {
    const v = getPath(doc, f);
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) {
      errors.push(`${file}: missing required field '${f}'`);
    }
  }
  for (const [pathKey, allowed] of Object.entries(enumFor)) {
    if (!allowed) continue;
    const v = getPath(doc, pathKey);
    if (v !== undefined && v !== null && !allowed.includes(v)) {
      errors.push(`${file}: '${pathKey}' = '${v}' not in [${allowed.join(', ')}]`);
    }
  }
  return errors;
}

const args = process.argv.slice(2).filter(a => a.endsWith('.json'));
if (args.length === 0) {
  console.log('No files to validate.');
  process.exit(0);
}

let total = 0;
for (const f of args) {
  const errs = validateOne(f);
  total += errs.length;
  errs.forEach(e => console.error(e));
  if (errs.length === 0) console.log(`OK  ${f}`);
}

if (total > 0) {
  console.error(`\n${total} validation error(s).`);
  process.exit(1);
}
console.log(`\nValidated ${args.length} file(s).`);
