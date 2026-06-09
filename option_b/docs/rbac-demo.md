# RBAC demo

The user-picker in the top bar selects between three demo identities:

| Demo user | Tier      | Sees                                        |
|-----------|-----------|---------------------------------------------|
| Analyst   | analyst   | All 10 projects (full access)               |
| HDR       | hdr       | Public + tier:hdr-accessible projects (~5)  |
| External  | external  | Public projects only (~2)                   |

## How it works

1. Frontend picker writes the choice into the `x-demo-user` header on every API call.
2. Worker's `auth.js` resolves the header to a user object: `{ id, tier, roles }`.
3. `rbac.js` builds an `aclFilter`:
   ```js
   { $or: [
       { 'access.preset': 'public' },
       { 'access.viewers': { $in: identities } }
     ]
   }
   ```
4. `search.js` injects this filter into both the `$vectorSearch.filter` slot and the standalone `$match` path. Same filter, both code paths, no post-filter.

## Why this is the demo's headline

Option_a cannot do this:

- GitHub repo permissions are coarse (repo-level, not document-level).
- Once `index.json` is shipped to the browser, every visitor has every project's metadata, regardless of intent.

Option_b filters at the database before any data leaves the cluster.

## Caveats for the demo

- `x-demo-user` is trusted blindly. In production this is SSO/OAuth.
- ACLs are seeded mechanically by `seed-acls.mjs` (illustrative). Production ACLs derive from Asana project metadata.
- Vector search results are post-filtered by Atlas using the same `filter` clause inside `$vectorSearch`, so RBAC and `numCandidates` interact: too low a candidate count can starve a tier-restricted user. The default of 100 candidates for 10 results is comfortable at Phase 1 scale.
