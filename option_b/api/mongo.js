// MongoDB client wrapper using the official Node driver, run inside the Worker
// via Cloudflare's nodejs_compat. Replaces the Atlas Data API path because the
// Data API has been deprecated by MongoDB.
//
// Required Worker secrets:
//   ATLAS_URI   mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/?retryWrites=true&w=majority

import { MongoClient } from 'mongodb';

export const DB = 'dash';
export const COLL = 'projects';

let cached;

function getDb(env) {
  if (!cached) {
    if (!env.ATLAS_URI) throw new Error('ATLAS_URI not set');
    const mc = new MongoClient(env.ATLAS_URI);
    cached = mc.connect().then(() => mc.db(DB));
  }
  return cached;
}

export function client(env) {
  return {
    async find(_db, coll, filter, opts = {}) {
      const db = await getDb(env);
      const cursor = db.collection(coll).find(filter, opts);
      if (opts.sort) cursor.sort(opts.sort);
      if (opts.limit) cursor.limit(opts.limit);
      if (opts.projection) cursor.project(opts.projection);
      return cursor.toArray();
    },
    async findOne(_db, coll, filter, opts = {}) {
      const db = await getDb(env);
      return db.collection(coll).findOne(filter, opts);
    },
    async insertOne(_db, coll, document) {
      const db = await getDb(env);
      return db.collection(coll).insertOne(document);
    },
    async updateOne(_db, coll, filter, update, opts = {}) {
      const db = await getDb(env);
      return db.collection(coll).updateOne(filter, update, opts);
    },
    async deleteOne(_db, coll, filter) {
      const db = await getDb(env);
      return db.collection(coll).deleteOne(filter);
    },
    async aggregate(_db, coll, pipeline) {
      const db = await getDb(env);
      return db.collection(coll).aggregate(pipeline).toArray();
    },
  };
}
