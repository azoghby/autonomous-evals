# Parent / final composition report

Owned directories only: `docs/workflow-resumption-integration/**` and
`tests/track-b/workflow-resumption-integration/**`. Parent: `687b5086e6bd204fe82809672c0511e2ee3e6f52`.
No files owned by `docs/track-b-final-composition` or the monitoring team changed.

Functional path supplied: authenticated review -> transactionally committed core
receipt + canonical decision + keyed intent -> same original durable Workflow
wait -> authoritative data advance/admission -> evaluation continuation. No
handoff callback is required to resume the new-definition Workflow. Cron recovers
queue loss; durable timers provide normal progress. Budget, agent ambiguity and
cost-delivery pending remain separate and never mean review ready.

Review overlap hunks when assembling the final chat+data+remediation+packs source:

- `server/data-production.ts`: imports, injectable pinned SQL in scoped(), and
  outer transaction around humanDataReview, including intent write after review.
- `workflows/steps/rich-evaluation.ts`: pending reason capture, snapshot/ack of
  visible intents around actual advanceData, and distinct review pending outcome.
  Preserve final-composition report/pack/remediation behavior in this file.
- `workflows/job.ts`: retain original Workflow only for review_pending, sleep and
  fresh wake check then fresh rich step invocation. Preserve the team's other paths.
- Add server resumption SQL helpers, wake step, cron route and migration verbatim
  only after reviewing final schema and final credential/authorization policy.

The SQL transaction flattening is intentionally local to authenticated intake;
never hand that adapter to provider work or add callback retries. The route and
wake step carry only immutable IDs. Pipeline authority and permissions are read
again by the actual service. No notification delivery was implemented.

Migration prerequisites: complete-workflow series first; then unique release
identity for `004-workflow-resumption.sql`; server-only grants; then app patch.
Pre-release review receipts and already terminated old-definition Workflow runs
need a separately reviewed conversion/restart procedure. Unknown liveness never
starts a worker. Generic A restart is not a review wake endpoint. This artifact
provides no claim reset/takeover, provider reconciliation or permission override.
A deliberately held ambiguous/dead legacy run is not claimed as resumed.

Validation runner uses actual assembled app/core and PostgreSQL SQL in PGlite;
Workflow boundary is scripted. Native PostgreSQL binaries unavailable. Hosted
Workflow compiler/replay, independent PostgreSQL transactions and final release
build remain unmeasured. See RESULTS.json for the final combined run.
