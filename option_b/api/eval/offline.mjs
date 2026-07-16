// OFFLINE PRE-DEPLOY GATE. Deterministic, no network, no model. Locks the
// classifier routing, the guard invariants, and the executor math against the
// bundled fixture. MUST be green before shipping any router/prompt/guard change.
//   node option_b/api/eval/offline.mjs
import fs from 'node:fs';
import { classifyCatalogue, runCatalogue } from '../catalogue.js';
import { regexIntent, guardIntent } from '../ask.js';
import { CASES } from './cases.mjs';

const docs = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const env = { MONGO_DO: { idFromName: () => 'i', get: () => ({
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ result: docs }) }) }) } };

let fail = 0;
const bad = (m) => { fail++; console.log('  FAIL ' + m); };
const fullIntent = (p) => ({ intent: 'semantic', data_type: '', facet: '', value: '', qualifiers: [], negated: false, people: [], topic: '', ...p });

for (const c of CASES) {
  // 1. Regex invariant: the fast path may DEFER (null -> router), but it must
  //    never MIS-fire. So a null is fine; a non-null intent must equal c.regex.
  if (c.regex) {
    for (const q of c.queries) {
      const got = regexIntent(classifyCatalogue(q));
      const gi = got ? got.intent : null;
      if (gi !== null && gi !== c.regex) bad(`[${c.name}] regex "${q}" -> ${gi} (must be null or ${c.regex})`);
    }
  }
  // 2. Guard invariant: a mock router misroute must be corrected deterministically.
  if (c.guard) {
    const out = guardIntent(fullIntent(c.guard.from), c.queries[0]);
    for (const [k, v] of Object.entries(c.guard.expect)) {
      if (out[k] !== v) bad(`[${c.name}] guard.${k} -> ${JSON.stringify(out[k])} (want ${JSON.stringify(v)})  on "${c.queries[0]}"`);
    }
  }
  // 3. Executor math against the fixture.
  if (c.exec) {
    const e = c.exec;
    const r = await runCatalogue({ kind: e.kind, facet: e.facet, value: e.value, type: e.type, negated: e.negated }, env);
    const got = e.kind === 'total' ? r.total : e.kind === 'count_by_value' ? r.count : r.projects.length;
    if (got !== e.count) bad(`[${c.name}] exec ${e.kind} -> ${got} (want ${e.count})`);
  }
}

console.log(fail === 0 ? '\nOFFLINE GATE: ALL PASS' : `\nOFFLINE GATE: ${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
