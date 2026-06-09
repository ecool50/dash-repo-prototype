# DASH Repository — Phase 1 status

**To:** Jean Yang, Alistair Senior, Ellis Patrick
**From:** Elijah Willie, Xiangnan
**Date:** 6 May 2026

## Bottom line

The hybrid architecture (MongoDB Atlas for retrieval + GitHub for content) approved in April is **validated and operational**. A working prototype with semantic search, document-level access control, and ten representative seed projects is running. No architectural changes are needed; we are clear to continue toward the Phase 1 MVP.

## How we got here

Before building further on the architectural choice, we built and tested both single-system alternatives — GitHub-only and MongoDB-only — to stress-test the original proposal. The result is two functional mockups exposing the same UI against the same data, making the trade-off concrete rather than theoretical.

## The trade-off in one table

| Requirement (from project specification) | GitHub-only | MongoDB-only | Hybrid (proposed) |
|---|:---:|:---:|:---:|
| Document-level RBAC at query time          | ✗ | ✓ | ✓ |
| Semantic vector search                     | ✗ | ✓ | ✓ |
| Compound structured queries                | ✗ | ✓ | ✓ |
| Version-controlled analytical content      | ✓ | ✗ | ✓ |
| Analyst-friendly workflow (`git push`)     | ✓ | ✗ | ✓ |

Each single-system alternative fails on a non-negotiable requirement. Only the hybrid satisfies all five.

## What is working today

- **MongoDB Atlas** with vector index, RBAC filter at query time, and query logging. Ten seed projects ingested.
- **Role switcher demonstrates real access control**: external researchers see 2 projects, HDR students see 5, DASH analysts see all 10 — filtering applied in the database before any data leaves the cluster.
- **Sub-300ms search** combining vector similarity + structured filters + ACL.
- **Reproducible setup** in under 30 minutes from a clean machine, fully documented.
- **All claims are inspectable.** The Atlas collections (`dash.projects`, `dash.search_logs`) can be opened directly to verify data and live query traffic.

## Recommended next steps

| Track | Effort | Owner |
|---|---|---|
| Conversational agent layer (Claude + retrieval as a tool) | ~1 week | Elijah |
| Scheduled Asana sync (tags + project metadata) | ~3 days | Xiangnan |
| Stakeholder pilot prep (Heejung Shim, Dario Strbenac) | ~1 day | All |

## Decisions we need from you

1. **Pilot timing.** When should we put a working version in front of Heejung or Dario for feedback?
2. **Asana access.** API token, plus confirmation of which fields are in scope for the sync.
3. **Production hosting budget.** Estimated ~$60-100/month for a hosted Atlas tier plus a small Node runtime, once we move beyond local dev. Confirm this is within budget.

## References

- Full technical analysis: `option_a/docs/architecture-tradeoffs.md`
- Reproducible setup: `option_b/docs/setup.md`
- RBAC walkthrough: `option_b/docs/rbac-demo.md`
- Layout rationale for option_b: `option_a/docs/option-b-layout.md`
