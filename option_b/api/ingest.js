// Ingest pipeline for POST /api/ingest.
//
// Behavior:
//   1. Validate the incoming document against schema_v1.json's required
//      fields and enums. Lenient for status='active' (drafts may be partial),
//      strict for status='complete'.
//   2. If `access` block is absent, apply $access_defaults.
//   3. Build embedding.source_text from the search-relevant fields,
//      hash it, and skip embedding if the hash matches what's already
//      stored (saves a Workers AI call when only non-search fields changed).
//   4. Call Workers AI to get a vector when needed.
//   5. Upsert on ref_number into dash.projects.
//
// Returns { ok, ref_number, action: 'inserted' | 'updated' | 'unchanged',
//           embedded: bool }.

import { client, DB, COLL } from './mongo.js';

const EMBED_MODEL = '@cf/baai/bge-large-en-v1.5';

const REQUIRED_FIELDS = [
  'ref_number',
  'title',
  'status',
  'project_details.research_area',
  'project_details.data_modality',
  'project_details.sample_info.n_samples',
  'project_details.sample_info.organism',
  'project_details.keywords',
  'analytical_methods.primary_methods',
  'analytical_methods.tools_packages',
  'analytical_methods.programming_languages',
  'analytical_questions.primary_question',
  'provenance.indigenous_health',
  'provenance.ethics_required',
];

const STATUS_VALUES = ['active', 'complete', 'on_hold', 'archived'];
const ACCESS_TIER_VALUES = ['private', 'dash_internal', 'dash_extended', 'cpc_engaged', 'cpc_all', 'usyd', 'public'];
const ACCESS_PRESET_VALUES = ['draft', 'shared', 'published'];

const ACCESS_DEFAULTS = {
  preset: 'shared',
  discovery: 'dash_internal',
  summary: 'dash_internal',
  report_link: 'dash_internal',
  code_link: 'dash_internal',
};

export async function ingestProject(doc, env) {
  if (!doc || typeof doc !== 'object') throw new Error('body must be a JSON object');
  if (!doc.ref_number) throw new Error("missing required field 'ref_number'");

  const strict = doc.status === 'complete';
  const errors = validate(doc, { strict });
  if (errors.length) {
    throw new Error('validation failed: ' + errors.join('; '));
  }

  // Apply access defaults if missing entirely.
  if (!doc.access) doc.access = { ...ACCESS_DEFAULTS };

  // Build source text and decide whether to (re)embed.
  const sourceText = buildSourceText(doc);
  const sourceHash = await sha256Short(sourceText);

  const existing = await client(env).find(DB, COLL, { ref_number: doc.ref_number }, { limit: 1 });
  const existingDoc = existing[0];
  const needsEmbed = !existingDoc
    || !existingDoc.embedding?.vector?.length
    || existingDoc.embedding?._source_hash !== sourceHash;

  let vector;
  if (needsEmbed) {
    const r = await env.AI.run(EMBED_MODEL, { text: [sourceText] });
    vector = r?.data?.[0];
    if (!vector?.length) throw new Error('embedding failed');
  }

  const now = new Date().toISOString();
  const update = {
    ...doc,
    updated_at: now,
    embedding: needsEmbed
      ? {
          model: 'bge-large-en-v1.5',
          source_text: sourceText,
          _source_hash: sourceHash,
          _embedded_at: now,
          vector,
        }
      : existingDoc.embedding,
  };
  if (!existingDoc) update.created_at = now;

  await client(env).updateOne(
    DB,
    COLL,
    { ref_number: doc.ref_number },
    { $set: update },
    { upsert: true }
  );

  return {
    ok: true,
    ref_number: doc.ref_number,
    action: existingDoc ? (needsEmbed ? 'updated' : 'unchanged') : 'inserted',
    embedded: needsEmbed,
  };
}

// --- helpers -------------------------------------------------------------

function validate(doc, { strict }) {
  const errors = [];

  // Required fields. In strict mode, all of REQUIRED_FIELDS must be present.
  // In lenient mode (status != 'complete'), only ref_number+title+status are.
  const required = strict
    ? REQUIRED_FIELDS
    : ['ref_number', 'title', 'status'];

  for (const f of required) {
    const v = getPath(doc, f);
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) {
      errors.push(`missing required field '${f}'`);
    }
  }

  // Enums (always checked when value is present).
  if (doc.status && !STATUS_VALUES.includes(doc.status)) {
    errors.push(`status '${doc.status}' not in ${JSON.stringify(STATUS_VALUES)}`);
  }
  const access = doc.access;
  if (access) {
    if (access.preset && !ACCESS_PRESET_VALUES.includes(access.preset)) {
      errors.push(`access.preset '${access.preset}' invalid`);
    }
    for (const k of ['discovery', 'summary', 'report_link', 'code_link']) {
      if (access[k] && !ACCESS_TIER_VALUES.includes(access[k])) {
        errors.push(`access.${k} '${access[k]}' invalid`);
      }
    }
  }

  return errors;
}

function buildSourceText(doc) {
  // Concatenate the fields the search vector should be sensitive to.
  // Anything outside this set won't trigger re-embedding.
  const aq = doc.analytical_questions || {};
  const qc = Array.isArray(doc.qc) ? doc.qc : [];
  const parts = [
    doc.title,
    // The current schema carries the "what was asked / what was checked"
    // signal in analytical_questions + qc, where findings.executive_summary
    // used to. Pull both so the embedding stays rich.
    aq.primary_question,
    (aq.other_questions || []).join(' '),
    qc.map((q) => [q?.qc_question, q?.qc_method].filter(Boolean).join(' ')).join(' '),
    doc.findings?.executive_summary, // legacy fallback for pre-template docs
    (doc.analytical_methods?.primary_methods || []).join(' '),
    (doc.project_details?.data_modality || []).join(' '),
    (doc.project_details?.disease || []).join(' '),
    (doc.project_details?.keywords || []).join(' '),
    (doc.analytical_methods?.tools_packages || []).join(' '),
  ];
  return parts.filter(Boolean).join(' | ');
}

async function sha256Short(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
