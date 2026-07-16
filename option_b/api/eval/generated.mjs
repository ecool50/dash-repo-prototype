// GENERATED exact-answer eval. Reads the 11 docs and mechanically derives one
// case per tool / disease / data-type / person, each with the ground-truth count
// computed from the docs, then checks the DEPLOYED agent end-to-end. This is
// broad coverage that self-updates as the catalogue grows — complementary to the
// hand-curated adversarial cases in cases.mjs. Reports mismatches (it is a
// coverage probe, not a deploy gate).
//   node option_b/api/eval/generated.mjs [baseUrl] [sample]
import fs from 'node:fs';
import { projectsOfType, CANONICAL_DATA_TYPES } from '../catalogue.js';

const BASE = process.argv[2] || 'https://dash-api.ecool50.workers.dev';
const SAMPLE = process.argv[3] ? Number(process.argv[3]) : 0; // 0 = all
const docs = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));

// Ground truth from the docs.
const tally = (vals) => { const m = new Map(); for (const d of docs) for (const v of new Set((vals(d) || []).map(String))) m.set(v, (m.get(v) || 0) + 1); return m; };
const tools = tally((d) => d.analytical_methods?.tools_packages);
const diseases = tally((d) => d.project_details?.disease);
const people = [...new Set(docs.flatMap((d) => { const i = d.investigators || {}; return [i.lead_data_scientist, i.collaborator, i.research_leader, ...(Array.isArray(i.analyst_team) ? i.analyst_team : [i.analyst_team])].filter(Boolean).flatMap((s) => String(s).split(/ and |, |; /)).map((s) => s.trim()); }))].filter((p) => p.length > 2);
const TYPE_TERM = { transcriptomics: 'transcriptomics', proteomics: 'proteomics', epigenomics: 'epigenomics', imaging: 'imaging', spatial: 'spatial', clinical_meta: 'clinical', wearable_sensor: 'wearable', study_design: 'study design' };

// Build the generated cases (query + expected count/refs).
const cases = [];
for (const [tool, n] of tools) cases.push({ kind: 'tool', q: `how many projects use ${tool}`, exp: n });
for (const [dis, n] of diseases) cases.push({ kind: 'disease', q: `how many ${dis} projects are there`, exp: n });
for (const t of CANONICAL_DATA_TYPES) cases.push({ kind: 'type', q: `${TYPE_TERM[t] || t} projects`, exp: projectsOfType(docs, t).length });
for (const p of people) cases.push({ kind: 'person', q: `projects by ${p}`, expMin: 1 });

let run = cases;
if (SAMPLE > 0) run = cases.filter((_, i) => i % Math.ceil(cases.length / SAMPLE) === 0).slice(0, SAMPLE);

async function ask(q) {
  const t = await (await fetch(BASE + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q, history: [] }) })).text();
  let cards = 0; for (const l of t.split('\n')) { if (!l.trim()) continue; let o; try { o = JSON.parse(l); } catch { continue; } if (o.type === 'matches') cards = o.matches.length; }
  return cards;
}
const batch = async (items, n, fn) => { const out = []; for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn))); return out; };

console.log(`Generated ${cases.length} cases (${tools.size} tools, ${diseases.size} diseases, ${CANONICAL_DATA_TYPES.length} types, ${people.length} people). Running ${run.length}.\n`);
const results = await batch(run, 4, async (c) => ({ c, cards: await ask(c.q) }));
const miss = [];
for (const { c, cards } of results) {
  const ok = c.expMin != null ? cards >= c.expMin : cards === c.exp;
  if (!ok) miss.push(`  [${c.kind}] "${c.q}" -> cards=${cards} (want ${c.expMin != null ? '>=' + c.expMin : c.exp})`);
}
console.log(`PASS ${run.length - miss.length}/${run.length}`);
if (miss.length) { console.log('MISMATCHES (investigate — may be router misroute or count logic):'); miss.forEach((m) => console.log(m)); }
