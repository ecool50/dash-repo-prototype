# Architecture trade-offs: GitHub-only vs MongoDB-only

This document compares two single-system alternatives to the DASH repository's current hybrid architecture (MongoDB for metadata + embeddings, GitHub for content). It exists to justify the hybrid choice and to document why neither system can stand alone.

## Context

The DASH repository must support:

- **Structured metadata** (ref number, title, status, investigators, methods, tags, modality, disease)
- **Semantic search** via vector embeddings (1536-dim, cosine similarity)
- **Compound structured queries** (e.g., proteomics + clinical + R + last 12 months)
- **Document-level RBAC**, applied at query time (not post-filter)
- **Conversational agent** as the sole user-facing surface for retrieval
- **Asana sync** of tags and project metadata
- **Analytical content**: Quarto HTML reports, R/Python code, notebooks
- **Search query logging** for retrieval-quality improvement

Phase 1 scale: 50-100 projects. Designed to grow.

## Capability matrix

| Dimension | GitHub-only | MongoDB-only |
|---|---|---|
| Structured queries (multi-field filter) | Client-side filter after Search API; 1000-result cap | Native, indexed, fast |
| Full-text search | Code Search (good for code, weak for prose) | `$text` index or Atlas Search |
| Semantic / vector search | None native — needs external store | Atlas Vector Search, native |
| RBAC at query time | Repo-level only; user/team via GitHub permissions | Document-level filter via `$match` on ACL field |
| Version control of content | First-class | None (would need GridFS + manual snapshots) |
| Concurrent writes (Asana sync, analyst pushes, embedding jobs) | Merge conflicts on metadata files | Atomic upserts |
| Storage cost (HTML + code) | Free / cheap on Pro plan | Atlas storage tier (~$0.25/GB/month) |
| Rate limits | 5000 REST/hr, 30 search/min, 1000-result cap | Driven by Atlas tier; no result cap |
| Audit / query logging | Needs separate system | `search_logs` collection trivially |
| Analyst workflow fit | Already push code via git | Requires publish step into Mongo |

## Where GitHub-only breaks

GitHub-only fails on three of DASH's hard requirements.

### 1. RBAC

The DASH spec requires filtering at query time, at document granularity, with tier-based access (primary stakeholders, HDR students, external researchers). GitHub's only access mechanism is repo-level permissions via team membership. Implementing per-project access would require:

- One private repo per project (50-100+ repos to administer)
- Per-user / per-team collaborator lists kept in sync with stakeholder status
- The agent enumerating visible repos via `GET /user/repos` before every query, then issuing N searches across that set

This is operationally heavy at Phase 1 scale and gets worse as the project count grows. It also can't express "this user can see project A's metadata but not its content," which the access model needs.

### 2. Semantic search

GitHub has no vector search. To get embedding-based retrieval, the system would need an external vector store (Pinecone, Weaviate, pgvector, etc.). At that point the architecture is no longer single-system: the source of truth is split across GitHub content and an external vector store, with sync drift between them — a worse position than the current hybrid.

### 3. Compound structured queries

A query like "proteomics + clinical + R + last 12 months" via the GitHub Search API means fetching a candidate set, paginating up to the 1000-result cap, then filtering client-side. The 30 req/min search ceiling and the result cap make this fragile even at Phase 1 scale. Aggregations (e.g., "how many proteomics projects in 2025?") are not supported at all and would require a separate index.

## Where MongoDB-only breaks

MongoDB-only fails on workflow fit and content suitability.

### 1. Loss of version control on analytical content

Quarto reports, R/Python code, and notebooks are the actual analytical artifacts the repository exists to preserve. They belong in version control: blame, diff, branch, PR review, history. GridFS gives blob storage, not any of those affordances. Storing reports in Mongo means the canonical version of an analysis no longer has a commit history — a substantive regression for a research artifact repository.

### 2. Friction at the publish step

DASH analysts already work in git locally. MongoDB-only requires a publish pipeline (CLI tool, GitHub Action, or web upload) that pushes report HTML and code into Mongo on every change. Every analyst's onboarding includes learning this pipeline. The current hybrid lets analysts continue using the workflow they already know — `git push` — and the metadata/embedding sync is a backend concern.

### 3. 16MB BSON document limit

Most Quarto HTML reports fit comfortably under 16MB, but reports with embedded plots, base64-encoded images, or large rendered notebooks can exceed it. GridFS works around the limit but is awkward for content meant to be served to a browser, and it complicates the simple "fetch one document, render it" pattern.

## Verdict

If forced to a single system, **MongoDB-only is more defensible than GitHub-only**, because the retrieval requirements (vector search, document-level RBAC, compound filters, query logging) are non-negotiable for the agent and GitHub cannot serve them without bolting on a second system. The cost of MongoDB-only is workflow friction for analysts and loss of native version control on analytical content.

The hybrid in the current architecture exists because each system is unbeatable in its own lane:

- **GitHub** for analyst-facing, version-controlled analytical content (code, reports, notebooks).
- **MongoDB** for agent-facing structured + semantic retrieval, RBAC, and query logging.

The fair framing is not "which system wins alone" but "what does the project give up by collapsing to one." Collapsing to GitHub-only sacrifices core product capability (the agent). Collapsing to MongoDB-only sacrifices analyst workflow and the version-control properties that make analytical artifacts trustworthy as a long-term knowledge base.

The hybrid is therefore the recommended architecture, and this document records the reasoning so that the choice can be revisited deliberately rather than drifted from.
