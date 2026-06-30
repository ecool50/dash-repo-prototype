// Durable Object that owns the MongoDB driver and a warm, pooled connection.
//
// The stateless request Worker proxies every DB operation here instead of
// holding its own connection. That is the reliability fix: previously each
// cold request isolate re-established a TCP connection to Atlas while loading
// the heavy driver, and that cold-connect-under-memory-pressure is what
// crashed the isolate (Cloudflare 1101, surfacing as "Failed to fetch"). One
// long-lived DO connects once and reuses the connection across requests.

import { DurableObject } from 'cloudflare:workers';
import { MongoClient } from 'mongodb';

const DB = 'dash';

export class MongoDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.dbPromise = null;
  }

  db() {
    if (!this.dbPromise) {
      const mc = new MongoClient(this.env.ATLAS_URI);
      this.dbPromise = mc.connect().then((c) => c.db(DB));
      // Un-poison the cache if the connection fails, so the next op reconnects.
      this.dbPromise.catch(() => { this.dbPromise = null; });
    }
    return this.dbPromise;
  }

  async fetch(request) {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: 'bad request body' }, { status: 400 });
    }
    const { op, coll, args = [] } = payload || {};
    try {
      const db = await this.db();
      const c = db.collection(coll);
      let result;
      switch (op) {
        case 'find': {
          const [filter = {}, opts = {}] = args;
          const cursor = c.find(filter, opts);
          if (opts.sort) cursor.sort(opts.sort);
          if (opts.limit) cursor.limit(opts.limit);
          if (opts.projection) cursor.project(opts.projection);
          result = await cursor.toArray();
          break;
        }
        case 'findOne':
          result = await c.findOne(args[0] || {}, args[1] || {});
          break;
        case 'insertOne':
          result = await c.insertOne(args[0]);
          break;
        case 'updateOne':
          result = await c.updateOne(args[0], args[1], args[2] || {});
          break;
        case 'deleteOne':
          result = await c.deleteOne(args[0]);
          break;
        case 'aggregate':
          result = await c.aggregate(args[0]).toArray();
          break;
        default:
          return Response.json({ error: `unknown op ${op}` }, { status: 400 });
      }
      return Response.json({ result });
    } catch (e) {
      this.dbPromise = null; // drop a possibly-stale connection; reconnect next time
      return Response.json({ error: String(e?.message || e) }, { status: 500 });
    }
  }
}
