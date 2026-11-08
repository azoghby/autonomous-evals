# Track A data production composition patch

`track-a.patch` is an applyable artifact against locally cached Track A **f0068733ca49c37f40fd7de279325f21a4b5fbbb**. No fetch occurred. It adds `apps/web/src/server/data-production.ts`, adds authenticated `GET/POST /api/jobs/[jobId]/data-review`, and exports the existing `buildAgentDeps` factory. Source copies live in `source/`. No application or existing core file was edited in this workstream.

Prerequisite: merge current Track B core with `advanceDataOrchestration`, initial-review/snapshot/producer-independence fixes from de6a798, `createAuthenticatedDataReviewLedger`, public discovery persistence, and this workstream's PostgreSQL operations implementation. The patch intentionally does not duplicate these engine services or edit contracts/manifests. It does not touch `docs/workflow-integration` or the Workflow team's files.

In the Track A owner's checkout:

```sh
git apply --check /absolute/path/to/docs/data-production-integration/intake/track-a.patch
git apply /absolute/path/to/docs/data-production-integration/intake/track-a.patch
```

Use the owner's migration process for the separate **artifact-only** `evals/data/persistence-migrations/001-evaluation-data.sql`, `002-data-operations.sql`, existing agent task/budget migrations, and `evals/integration/migrations/001-text-integration.sql`. None run on factory construction or HTTP requests. The existing database URL is read only inside the private server module. The existing encryption key decrypts authorized job credentials solely for refusal screening; credentials do not enter candidate data, prompts, progress, or patch output.

## Exact Workflow producer seam

The owning Workflow step must authorize its durable job plan and call:

```ts
import { advanceProductionData } from '@/server/data-production';

const result = await advanceProductionData(job.id, {
  task: authorizedPersistedPlan.dataTask,
  initial: authorizedPersistedPlan.initialCandidates,
  context: {
    versionLabel: authorizedPersistedPlan.versionLabel,
    systemPrompt: authorizedPersistedPlan.systemPrompt,
  },
  // Optional trusted operator-selected MediaWiki origin and bounded queries.
  // discovery: authorizedPersistedPlan.publicDiscovery,
});
```

Those property names describe the step's required inputs, not a claim that Track A already persists a `dataTask` plan. The Workflow team must choose and persist that plan before invoking this seam. Do not expose this function as a server action, route, model tool, public share capability, or user-chosen tenant/job mutation. It grants provider dispatch through the existing durable agent task/budget service. An HTTP review submission never calls it or resumes a workflow.

The factory reloads `jobs`, pins customer/job/environment, refuses mock/non-text jobs, reloads current credential refusal values, binds immutable `data-production-input:<taskId>`, and constructs:

```ts
createPostgresDataOperationLedger(sql, {
  tenantId: row.customer_id,
  jobId,
  ownerId: 'data_service_v1',
  authenticateOwner: /* private service authority + database job/scope recheck */,
  knownSecrets: currentServerAndJobSecrets,
});
```

`sql` is the existing pinned WebSocket pool transaction adapter; Neon HTTP queries cannot substitute for it. The shared stable owner is a private server capability spanning workers/restarts/intake/cost capture. Its string is not an authorization token. The private database role and module boundary supply the authority; the callback validates the pinned job binding on writes. Browser/model SQL credentials or a caller-supplied owner callback are unsupported. No reconciliation endpoint, expiry, takeover, claim reset, or arbitrary operator completion is supplied.

## Human review and immutable snapshots

`advanceDataOrchestration.readReview` first captures `{task,candidates}` under `data-review-request:<digest>`. This is necessary because acquisition has not committed the merged batch when human review is pending. Review GET reads that exact immutable snapshot with the authenticated operator session. POST accepts only `{digest,receiptId,decision,reviewed}`; task/candidates/principal/authority never come from the request. The existing real session and operator allowlist authorize human intake, and the core ledger enforces source/case producer and target independence. Principal identity is stamped from the authenticated session; the human explicitly supplies the permission and evidence determinations. There is no fixture human or model selfapproval.

POST requires an exact same-origin `Origin`, JSON content type, and at most 500 KB streamed input. Errors contain fixed prose. GET/POST require operator access; customer ownership and public job sharing do not grant review authority. Review data is private. Candidate task/body identity remains immutable across awaits and receipt replay. Initial imported approvals are stripped by existing orchestration and still go through this gate.

Review examples are deliberately omitted: no invented reviewer, forged consent, canned factual verification, or autoapproved license may be copied into production. A rejected decision remains a rejected immutable decision. Revising evidence requires a new authorized task/input identity; do not rewrite an existing receipt.

## Generation, costs, expert drafts and actual freeze

Generation uses `createNaiveGenerationAdapter` with the exported **existing** `buildAgentDeps().runner`, durable task storage, aggregate job and role budget ledger, a 250,000 micro-USD session cap and 3,000,000 micro-USD text-job cap. Missing runtime configuration blocks; there is no fallback provider. Measured generation cost is captured before operation completion and delivered through the orchestration outbox.

The sink writes the actual existing `costs` table and serializes delivery on the existing `jobs` row. It compares and replays immutable `naive:<externalId>` entries rather than incrementing a total. This key assumes a provider session external ID is globally unique; it is stronger than task+external deduplication. Every other writer using those same IDs must adopt this lock/deduplication protocol or an owner-reviewed unique-key migration before concurrent production use. Existing append-only `job-store.recordCost` must not independently receive these same data/design costs. Different measured content under one identity blocks rather than rewriting history. Unknown usage remains unknown; no cost is inferred from a missing row.

Trusted configured public discovery uses the existing bounded MediaWiki adapter and PostgreSQL discovery checkpoints; undefined discovery performs no lookup. Expert work produces immutable private draft records only. No recipient selection, sending, hiring, payment, or expert approval occurs. A pending expert or provider operation stays fenced and requires evidence-based reconciliation for later completion.

Approved data goes through **`mapApprovedDataToTextDesign`**, then actual **`designTextSuite`**. The existing engineer draft, independent investigator review, deterministic objective/rubric admission, twelve-scenario requirement and `freezeSuite` path remain authoritative. Returned suites are checked with `verifyAdmittedFrozenSuite`; orchestration additionally binds exact approved reference/provenance through `frozenDataReference`. Data approval alone never constructs a frozen suite. A blocked/pending design returns pending to the outer operation and becomes `reconciliation_required`, with no automatic design/generation redispatch. Review, cost, mapping or freeze incompleteness cannot return ready.

Design usage is captured immutably as `data-design-cost:<taskKey hash>` before delivery. Each bounded advance first drains at most 1,000 such cost records through the scoped ledger and idempotent sink, including when an interrupted freeze remains pending. A larger inventory blocks for operator inspection. This recovers a lost accounting acknowledgement without redispatching design. An interrupted freeze itself still requires reconciliation of the original durable agent sessions and exact approved reference/suite; costs settling alone cannot complete it.

Only `result.status === 'ready'` with `result.frozen` is an approved data-bound frozen suite. The Workflow team owns persisting that suite and its provenance sidecar and feeding the existing run/investigation/report services. Preserve rich unknown/incomplete statuses; do not invent a legacy boolean pass or re-freeze a suite after approval.

## Offline validation and remaining live obligations

```sh
node docs/data-production-integration/intake/validate.mjs
```

The validator uses a disposable `git archive` of the exact Track A base, checks and applies the real patch, overlays current Track B engine prerequisites, runs targeted strict TypeScript, and executes **10 passing tests, none skipped**. It uses existing dependencies at `/tmp/track-b-harness/node_modules`; override with `DATA_INTAKE_NODE_MODULES`. No install/network/provider/deploy occurs. Staging is retained and printed for inspection.

Five route tests exercise exact job/digest forwarding, explicit review fields, CSRF/content type refusal, streaming bounds/unknown-authority fields, and fixed safe errors. Five composition tests execute the actual applied module with PGlite and actual operation/review ledgers, covering denial before SQL candidate reads, durable exact snapshot and cross-job refusal, producer-selfapproval and payload swap rejection, immutable receipt replay, and incomplete freeze fencing across retry with one mocked design invocation and zero generation dispatches. The latter mocks a blocked design outcome; it does not claim live suite quality. Existing core orchestration and storage tests provide the engine design/generation behavior coverage.

Targeted TypeScript uses structural fixture declarations for unavailable Next session and Neon SDK boundaries. The full Next workspace build, real Neon pinned transport compatibility, real authenticated browser flow, authorization revocation races, full provider budget/accounting integration, live generation/discovery/design quality, approved expert contribution intake, Workflow plan persistence/producer wiring, artifact persistence and operator reconciliation remain owner release obligations. PostgreSQL migrations here are artifacts, not applied cloud changes. This patch makes composition concrete and reviewable; it does not claim a deployed or live accepted data pipeline.
