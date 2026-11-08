# Follow-on integration seams

Judging (`docs/workflow-judging-integration`) and rerun (`docs/workflow-rerun-integration`) teams remain separate and were not imported into this artifact.

Use this combined stager as the base for their eventual composition. Rich-driver changes must preserve the reviewed merge's `captureReviewIntents -> advanceData -> finishReviewIntents` ordering, distinct pending labels, pack authorization before baseline dispatch, and approved-suite provenance. Review intents acknowledge only the captured snapshot; later intents stay pending. `workflow/job.ts` now retains the original Workflow on review_pending; rerun logic must not treat review wake as a new paid run or use the generic restart endpoint as a wake API.

Comparison admission still binds exact retained suite/run/target/version/inventory and payment/subscription policy. Monitoring reuses its retained approved baseline; unsupported appended comparison scope must remain refused. Judging changes must not reinterpret comparison outcomes or widen approved suite membership. Subsequent migrations need unique full IDs after 007 with explicit predecessors and transaction ownership; regenerate combined inventory and owner patch after any extension.

Legacy old-definition dead/ambiguous runs need a separately reviewed conversion/restart process. Neither readiness nor a fake checkpoint can prove their resumption. No providers, routes or database configuration were enabled here.

## Rerun next gate (read-only review completed)

Reviewed the available local commit `99d74799abf5e7a972b7c6b70654a59a02c5fa0b` (original `af94ac2eafa54a93a5a0de6391ac7c371bbcc7ee`). Its SERIES pins final predecessor `883d186a94ea38aeb122afeb9d9e9bd2ee0c6e24`, core `687b5086e6bd204fe82809672c0511e2ee3e6f52`, and rerun patch SHA-256 `200e11c07fc3d40937e9ee410b464bead40f00406678261c532f80de56320da3`. The artifact is not present in this worktree; it was inspected via `git show`, without cherry-picking or altering its files.

The rerun patch passes `git apply --check` on the combined comparison/resumption stage. This establishes textual compatibility only. It is explicitly **not included** in `application.patch` or the current migration manifest. Its delivered-owner authority mode in rich-services, shared HTTP/MCP idempotency, job-actions and report appendices require combined functional validation and judging-overlap review before inclusion. The reported original 12 tests/strict TS were not rerun by this extension task and are not part of its pass count.

Planned canonical next identity: `app.workflow-finding-reruns.008`, filename `008-workflow-finding-reruns.sql`, retaining SQL SHA-256 `9884992989f6aafb1861708ad426924651f172b90295fb13e8a78e06e1e688e7`. Record an explicit alias from proposed historical `app.workflow-finding-reruns.006` / `006-workflow-finding-reruns.sql` before deployment; never auto-discover by ordinal. Preserve original dependencies `app.workflow002`, `app.workflow-remediation.004`, `app.workflow-packs.005` and add `app.workflow-resumption.007` to the final ordered manifest. SQL is runner/owner-transaction managed. If the historical full ID has already been applied anywhere, owner registry reconciliation must resolve that identity first, rather than execute a renamed duplicate.

Next gate: obtain the pinned rerun artifact, reproduce its source preimages, review judging/rich-services authority overlaps, apply the six paths, explicitly canonicalize 008, run its original 12 plus all current combined suites and core/app/Next Workflow build, then regenerate inventory and fresh latest-A owner patch. No claim that reruns are enabled in this release.
