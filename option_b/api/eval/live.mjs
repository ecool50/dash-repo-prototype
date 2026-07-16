// LIVE POST-DEPLOY EVAL against the deployed Worker (local dev can't run the
// router or Mongo). Checks LLM routing quality (/api/route) and full cascade
// behaviour (/api/ask). Run after deploying a router/prompt change; if it goes
// red, roll back. knownGap cases are reported but do NOT fail the run.
//   node option_b/api/eval/live.mjs [https://dash-api.ecool50.workers.dev]
import { CASES } from './cases.mjs';

const BASE = process.argv[2] || 'https://dash-api.ecool50.workers.dev';
const post = async (path, body) => (await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

async function routeOf(q) { const j = await (await post('/api/route', { query: q })).json(); return j.intent; }
async function askOf(q) {
  const t = await (await post('/api/ask', { query: q, history: [] })).text();
  let a = '', cards = 0;
  for (const l of t.split('\n')) { if (!l.trim()) continue; let o; try { o = JSON.parse(l); } catch { continue; } if (o.type === 'token') a += o.text; else if (o.type === 'matches') cards = o.matches.length; }
  return { a, cards };
}

let fail = 0, gap = 0, checks = 0;
const bad = (known, m) => { if (known) { gap++; console.log('  gap  ' + m); } else { fail++; console.log('  FAIL ' + m); } };

for (const c of CASES) {
  if (!c.route && !c.ask) continue;
  const known = !!c.knownGap;
  // paraphrase consistency: collect the routed intent for each phrasing
  const routed = [];
  for (const q of c.queries) {
    if (c.route) {
      checks++;
      const o = await routeOf(q); routed.push(o.intent);
      for (const [k, v] of Object.entries(c.route)) {
        const got = k === 'value' ? String(o[k] || '').toLowerCase().includes(String(v).toLowerCase()) : o[k] === v;
        if (!got) bad(known, `[${c.name}] route.${k} "${q}" -> ${JSON.stringify(o[k])} (want ${JSON.stringify(v)})`);
      }
    }
    if (c.ask) {
      checks++;
      const { a, cards } = await askOf(q);
      const A = a.toLowerCase();
      if (c.ask.cards != null && cards !== c.ask.cards) bad(known, `[${c.name}] ask.cards "${q}" -> ${cards} (want ${c.ask.cards})`);
      if (c.ask.cardsMin != null && cards < c.ask.cardsMin) bad(known, `[${c.name}] ask.cards "${q}" -> ${cards} (want >=${c.ask.cardsMin})`);
      for (const s of c.ask.contains || []) if (!A.includes(s.toLowerCase())) bad(known, `[${c.name}] ask "${q}" missing "${s}"  got: ${a.slice(0, 90)}`);
      for (const s of c.ask.notContains || []) if (A.includes(s.toLowerCase())) bad(known, `[${c.name}] ask "${q}" MUST NOT contain "${s}"  got: ${a.slice(0, 90)}`);
      if (c.ask.containsAny && !c.ask.containsAny.some((s) => A.includes(s.toLowerCase()))) bad(known, `[${c.name}] ask "${q}" none of ${JSON.stringify(c.ask.containsAny)}  got: ${a.slice(0, 90)}`);
    }
  }
  if (c.route && new Set(routed).size > 1) bad(known, `[${c.name}] paraphrase SPLIT: ${[...new Set(routed)].join(',')}`);
}

console.log(`\nLIVE EVAL: ${checks} checks, ${fail} failures, ${gap} known-gap.`);
process.exit(fail === 0 ? 0 : 1);
