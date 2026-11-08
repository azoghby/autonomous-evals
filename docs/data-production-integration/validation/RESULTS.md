# Validation and remaining obligations

Final core validation used current owned source plus locally cached Track A contracts at `f0068733ca49c37f40fd7de279325f21a4b5fbbb` (contract digest `dc7936cf343e023a9f0b3b2c0ee02b3886a1f230397f282ee4aaec84a9b27101`). No fetch or dependency install was performed.

```sh
TRACK_B_NODE_MODULES=/path/to/existing/node_modules \
node tests/track-b/data-orchestration-review/run.mjs --components evals --track-a-ref origin/track-a
```

Strict TypeScript and **466 tests across 30 files passed, none skipped**. This includes the 19 new SQL operation tests, existing orchestration tests and R1–R3 review regressions. See [full output](evals-results.txt). Local dependencies were assembled using symlinks to existing `/tmp/track-b-harness` and `/tmp/trackb-harness`; no repository manifest changed. An earlier attempt used an incomplete dependency directory; another staged an in-progress cost fixture and failed. The final run used the finalized sources and passed.

Native PostgreSQL: **five assertion groups passed across eight independent backend sessions**, including claim/completion races, lost acknowledgements, authenticated reconciliation, immutable receipts/deletion and actual server restart. Exact adapter/migration hashes and runtime versions are in [storage evidence](../storage/validation.json). The PGlite promise concurrency test alone does not demonstrate independent sessions; the native verifier does.

Track A composition validation passed the exact-base patch apply check, targeted strict TypeScript, and **10 tests across two files, none skipped**; see [output](intake-results.txt) and [intake documentation](../intake/README.md). Its external auth/SDK/driver boundaries use offline fixtures; it does not prove a deployed Next/Neon/provider integration. SQL and human fixtures are explicitly synthetic test evidence, never real approvals, factual verification, provider bills or expert consent.

## Obligations before live activation

1. Integrate the core files and review/apply the pinned Track A patch; coordinate `advanceProductionData` with the Workflow owner. This workstream does not alter `docs/workflow-integration/**` or wire a second scheduler.
2. Have the authorized migration owner apply SQL artifacts with a least-privilege server-only application role. No production/cloud migration ran here.
3. Validate the real session/operator allowlist, job ownership, current credential screening and stable server service capability. Keep generic ledger and workflow advance functions out of public/model request surfaces.
4. Obtain independent authenticated human source/candidate/answer review and real permission, factual evidence, expert qualification and consent. Imported approvals and model judgments cannot substitute.
5. Reconcile pending provider/discovery/expert/freeze operations against actual durable evidence. Supply a receipt verifier that checks every binding before authorizing a different owner; no expiry or takeover exists. Never redispatch an ambiguous generation effect.
6. Verify real measured generation/design costs and idempotent delivery into the existing cost table, including the design-cost drain's documented bounded limit. Unknown costs or delivery failure remain blocking.
7. Complete actual text design/investigator admission and freeze, validate the frozen reference/provenance, and hand the frozen suite to the existing workflow service. Unknown/incomplete/rejected evidence must remain blocked.

No provider calls, spending, outreach, secret retrieval, cloud migrations, deployment, push or PR occurred. Only a disposable loopback PostgreSQL server was used for native SQL verification.
