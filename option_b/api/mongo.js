// Thin client used by the stateless request Worker. It does NOT hold a Mongo
// connection; it proxies every operation to the MongoDO Durable Object (see
// mongo-do.js), which owns the driver and a warm pooled connection. This keeps
// the heavy driver and its TCP connection out of the per-request isolate, which
// is what was causing the intermittent Cloudflare 1101 crashes.
//
// The client(env) interface is unchanged, so search.js / ingest.js are not
// touched.

export const DB = 'dash';
export const COLL = 'projects';

async function call(env, op, coll, args) {
  const stub = env.MONGO_DO.get(env.MONGO_DO.idFromName('mongo'));
  const res = await stub.fetch('https://mongo-do/op', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, coll, args }),
  });
  const data = await res.json().catch(() => ({ error: `mongo DO HTTP ${res.status}` }));
  if (!res.ok || data.error) throw new Error(data.error || `mongo DO HTTP ${res.status}`);
  return data.result;
}

export function client(env) {
  return {
    find: (_db, coll, filter, opts = {}) => call(env, 'find', coll, [filter, opts]),
    findOne: (_db, coll, filter, opts = {}) => call(env, 'findOne', coll, [filter, opts]),
    insertOne: (_db, coll, document) => call(env, 'insertOne', coll, [document]),
    updateOne: (_db, coll, filter, update, opts = {}) => call(env, 'updateOne', coll, [filter, update, opts]),
    deleteOne: (_db, coll, filter) => call(env, 'deleteOne', coll, [filter]),
    aggregate: (_db, coll, pipeline) => call(env, 'aggregate', coll, [pipeline]),
  };
}
