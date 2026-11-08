# Appended pack private projection patch

Owned artifact only: `docs/workflow-pack-integration/projection/**`. No actual
application/core files changed in this checkout. No ECC, children, installation,
provider/cloud access, secrets, spend, outreach, push, PR or broad build/SQL suite.

## Exact composition

Start from Track A `f0068733ca49c37f40fd7de279325f21a4b5fbbb` archive.
Apply `docs/progress-chat-integration/combined.patch`, then overlay the seven core
directories in `docs/workflow-integration/SERIES.json` from
`48519bf16e04bce3397ceaeb8abea060d2636263` (contains `c63a67a`, checked by
`stage.mjs`). Retain Track A contracts/redteam/DB/integration sources. Apply:

1. `docs/structured-progress-integration/backend/structured-progress.patch`
2. `docs/workflow-integration/service-bootstrap/0001-rich-service-bindings.patch`
3. `docs/workflow-integration/workflow-producers/002-workflow-producers.patch`
4. `docs/workflow-pack-integration/projection/003-pack-projection.patch`
5. The execution sibling's patch (independent execution files; imports this seam).

`node docs/workflow-pack-integration/projection/stage.mjs` checks and applies this
exact composition in a disposable archive. No checkout/worktree/migration is
created or applied to production. Existing rich-artifact migration remains
required; this patch introduces no schema or dependency.

## Execution integration seam (required)

The sibling owns `workflow-packs.ts` and `rich-evaluation.ts`; neither is touched
here. The application driver must use the authorized core pack service and the
COMPLETE `draftFromAppendedInventory` selection; no filtered accepted-only list.
Core `service.report(jobId, packRunId)` is the authoritative reconstruction seam.
Never build a manifest registry or report from intake-supplied check specs.

```ts
import {
  attachWorkflowPackEvidence, containsWorkflowPackArtifactSecret,
  retainedWorkflowPackBaseline, appendWorkflowPackReport,
} from '@/server/workflow-pack-projection';

// service.report authenticates the caller, review and target configuration again.
const packEvidence = await service.report(jobId, packRunId);
evidence = attachWorkflowPackEvidence(evidence, packEvidence);
// Replace the old combined containsSecret(JSON.stringify({ evidence, report }))
// guard: it misidentifies the core manifest's authorization metadata as a secret.
if (containsWorkflowPackArtifactSecret(evidence, api.knownSecrets)
  || containsSecret(JSON.stringify(report), api.knownSecrets)) throw blocked;
await persistRichArtifact(db, scope, baseSuite.digest, evidence, api.knownSecrets);
// Existing report persistence follows. The patched authenticated download route
// automatically appends the projection to markdown and HTML report downloads.
```

`containsWorkflowPackArtifactSecret` renames only the manifest authorization
metadata object KEY in a disposable scanning representation; every value remains
scanned, including known-secret literals. Stored manifest bytes/digests and the
core redactor are unchanged. Other credential assignment fields are still refused.
The driver must call this exported guard before its existing raw JSON guard can
block valid manifests. Report prose remains scanned by the original guard.

Preserve the original `{format,suite,run,investigation,limitations}` body and add
`appendedPack` using `attachWorkflowPackEvidence`. It checks the base suite digest,
clones everything and preserves full raw manifests/specs/checks/quotes privately.
The existing immutable artifact writer additionally binds pack job/environment
and base digest; read joins bind tenant/environment again. Do not persist a
base-only artifact first, then try to overwrite it with pack results. Changed
replays conflict. A retained unresolved snapshot stays unresolved; post-reconciliation
artifact revisions need an explicit owner-designed storage lifecycle rather than
replacement run IDs that bypass core dispatch fences.

The core checkpoints persist the full expected manifest before dispatch. Their
pending/ambiguous cases must remain fenced. Execution should obtain a durable
report even on incomplete dispatch and retain unknown/quarantined entries. This
patch does not add dispatch, external review authority, or a second runner.
Calendar appended scope remains blocked unless the execution owner supplies a
separately reviewed compatible pack contract; text base12 admission stays intact.

## Concrete report/progress behavior

The patched authenticated artifacts route supports `evidence`, `report`,
`report-html`, and new `pack-progress`. It uses the existing viewer authorization
and tenant/environment-bound private reader/current known credentials. Report
markdown/HTML now includes all expected appended IDs, their admission and outcome,
separate base12 and pack status, full-scope status and base12 remediation warning.
HTML uses the existing escaping renderer and sandbox headers. No responses, source
rules, free-form reasons or credentials are inserted into the appended prose.

`pack-progress` returns `projectWorkflowPack()` as private/no-store JSON. Every
manifest entry appears in order, including unknown trusted IDs and unsupported
semantics. Missing/partial checks become unknown; supplied aggregate pass claims
are ignored. Failure precedence does not remove simultaneous coverage gaps.
Base12 with absent run stays unknown even if a caller asserts pass. Missing private
pack evidence returns 404 rather than a completed/zero-work status; malformed or
redaction-refused evidence returns 409 with fixed prose.

This is an actual private report/download integration, not a chat schema expansion.
The existing structured chat progress adapter is unchanged and does not certify
pack completion. Before the final envelope is retained, core checkpoint inventory
is durable but this new download is unavailable; live chat projection/wakeup of
pack checkpoints remains separate owner work. Consumers must use the private
pack projection alongside base12 progress, never infer full coverage from base12.

## Full-scope baseline and remediation constraints

`retainedWorkflowPackBaseline(fullArtifact)` returns `{runId,digest}` where runId
is the pack run and digest is canonical SHA-256 of the COMPLETE retained artifact,
including base, manifest, private evidence and investigation. Bind immutable
monitoring/comparison ticks to that identity. Changed full artifacts require new
tick IDs. This does not replace core comparison baseline authority or validation.

For actual version comparison, retrieve both authorized durable core reports and
call core `comparePackRuns(left,right,historicalPinnedRegistry)`. Preserve its
union of expected IDs and unpaired reasons; keep the separate base comparison.
Do not feed pack results into legacy boolean converters or treat the projection's
`passed` value as comparison evidence. This patch does not implement a monitor.

The projection always marks remediation `base12_only`, `certifiesPack:false`.
Existing base12 fixes cannot certify packs. Full-pack remediation requires a new
review for the patched actual target configuration, fresh authorized pack execution
under a new identity, and retained full-scope evidence. This patch makes no such
verification claim.

## Focused offline validation

```
WORKFLOW_NODE_MODULES=/absolute/existing/node_modules \
  node docs/workflow-pack-integration/projection/validate.mjs
```

Local validation 2026-11-07: patch application checks passed on the exact archive
composition; strict TypeScript passed for the projection and fixture/tests;
15 tests in 3 files passed, none skipped. Tests run the actual patched projection,
authenticated report/HTML/evidence/progress route, and private artifact writer/
reader SQL against PGlite with the existing artifact migration. Coverage includes
all accepted/quarantined IDs, partial/unknown rules, aggregate-pass forgery, base12
pass with pack gaps, secret scans, complete baseline identity, immutable replay,
tenant/environment isolation and denied reads. No providers or broad SQL suite.
The route is runtime-tested, not a full Next/Workflow SDK build or deployed DB
acceptance. Execution sibling composition still requires the parent combined check.
