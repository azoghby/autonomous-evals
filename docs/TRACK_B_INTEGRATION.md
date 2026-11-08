# Track B integration and acceptance

Status: implementation in progress. This document specifies integration requirements, not completed capabilities. PLAN.md is the product baseline; TRACKS.md sets ownership. Track A owns app/platform configuration and application database migrations. Track B owns engine services and simulator migrations.

## Parent integration checkpoint (2026-11-07)

The remediation factory is exported and its invalid-initial-budget recovery defect
is fixed. The current private-chat patch package is integrated as a handoff artifact.
Against pinned Track A `eee9939b290190886fa9aa11fd32ff84442f05f2`, the full harness
passed strict TypeScript and 987 tests across 61 files, none skipped. The 25
`KNOWN GAP` cases pin unresolved contract limitations, not completed integration.
After integrating rubric authority/template construction revision `ac82f9e`, the
changed evals/judges components passed strict TypeScript and 429 tests across 27 files.
The separate remediation review passed 458 tests with one explicit expected failure
documenting the missing secured adapter; its budget-recovery case now passes normally.
The chat patch was reapplied to its exact base and passed all 51 core/server/UI tests
and targeted server/client typechecks. These are offline checks, not a deployed app,
live provider acceptance, or proof of real Neon SDK/session connectivity.

## Integration boundary

Track B exports TypeScript services for Track A's Workflow steps. It does not start a second job orchestrator, call public customer routes, send outreach, collect payments, or manage Vercel configuration.

The latest Track A composition status and remaining wiring sequence are recorded in
[track-b-bootstrap.md](track-b-bootstrap.md). The unified `@ae/core/evals/index`
entry exports factories, not an implicitly authorized global service instance.

The first deliverable is Trace Audit. It accepts a bounded transcript plus optional system instructions, returns evidence-linked findings and report artifacts, and does not require a customer endpoint or simulator branch. Text and calendar evaluations follow.

Track A published initial contracts on branch `track-a`, commit `673873d`, at `packages/core/src/contracts/index.ts` and `services.ts`. These define `EvalServices`: qualify, auditTrace, checkTarget, designSuite, runSuite, investigate, renderReport, createJobBranch, deleteJobBranch, and rerunFinding. Their implementation is not yet integrated into main. The agent implementation notes will live in `docs/track-b-agents.md`; target/simulator implementation notes in `docs/track-b-targets.md`.

### Contract gaps to resolve before wiring production execution

- `ServiceContext.budgetMicroUsd` is a number, not an atomic reservation. Engine construction must also receive durable budget/session persistence adapters; concurrent invocations cannot authorize spending from this number alone.
- `RunResult.results` currently has only `passed: boolean` plus text. Preserve richer execution outcomes internally and extend the integration contract before displaying infrastructure errors or inconclusive checks as product failures.
- The current `Suite.scenarios.max(32)` permits empty/short suites. The engine must enforce the planned twelve reviewed scenarios for ordinary full evaluation jobs; deliberate scope reductions must be recorded. Track A's appended red-team cases require separate execution/reporting integration.
- Intake trace `.max(MAX_TRACE_BYTES)` measures string length rather than UTF-8 bytes. The engine must independently enforce the 200 KB byte cap, including multibyte input.
- `rerunFinding` receives a finding/scenario but no target credentials or frozen initial state. Resolve these from authorized durable job storage; never infer a target or state from untrusted finding text.
- `deleteJobBranch(branchId)` must use a stored job-to-branch association and verify ownership; an arbitrary branch ID is insufficient authority to delete.
- Findings currently have evidence excerpts and scenario IDs but no typed branch/run association. Persist those associations separately and expose safe reproduction identifiers without database connection strings.

These are integration requirements identified from the published contracts, not changes made to Track A's files.

### Current contract checkpoint (afd4737)

The initial service list above is historical. The current Track A contract also requires
`proposeAndVerifyFix` and optionally exposes `getJobBranchConnection`. Track B supplies the
ownership-checked connection resolver and now supplies an explicit
[remediation service factory](track-b-remediation.md). Its bounded verification executes
all 12 unchanged frozen text scenarios with isolated patch-application receipts.
Secured adapter composition and production acceptance remain open; trace rechecking
alone cannot prove that a customer's behavior has changed.

Private progress chat now has a PostgreSQL conversation adapter and a separate migration
artifact, plus a [durable progress projection](track-b-progress-projection.md).
The app must still supply authenticated routes, authorized job inventories and consistent
storage reads for that projection.
The current [chat integration package](progress-chat-integration/README.md) supersedes
the old `docs/progress-chat-ui/` handoff and includes concrete routes, persistence and UI
patches against Track A `96cb4ad`; it is not a deployed interface. Evaluation-data
acquisition has quality/provenance gates and expert drafts, but no expert outreach has been
sent and no contributed dataset has been validated in production.

### Persistence supplied by Track A

- Authorize the job/customer before invoking engine services. Customer input must not choose another customer's job ID, credential reference, branch, or run.
- Supply durable session records and atomic budget reservations. Persist intent before session creation and persist returned IDs immediately; recover known sessions rather than recreating them.
- An ambiguous create response without a session ID is a reconciliation/manual-review condition. A database transaction cannot make an external provider call atomic. Never retry creation simply because no session ID was saved.
- Store phase outputs before advancing, including frozen suites, executions, findings, costs, report references, and intervention records. Repeated Workflow steps must reuse durable results or idempotent operations.
- Reserve against the aggregate job cap before every agent dispatch. Job caps are $3 single-version and $5 comparison; reservations must hold under concurrent calls. Unknown usage is not zero cost.
- Provide decrypted target credentials only to the transport layer. Never pass them to agent prompts, findings, logs, or exported artifacts.

### Infrastructure supplied by Track A

- Naïve SDK authentication and four configured agent identifiers/versions, with period caps of $35 Commercial, $65 Engineer, $65 Investigator, and $35 Operator.
- AI Gateway configuration for subjective judges and hosted fixtures. Record judge usage separately from Naïve usage and unknown customer-provider costs.
- Neon application storage plus a simulator seed branch. Track B supplies simulator schema and branch lifecycle functions; Track A supplies project authorization and invokes cleanup.
- Private artifact persistence and authorized downloads. Do not expose database connection URLs or raw branch credentials in customer reports.
- Credential deletion 24 hours after delivery and simulator branch deletion 48 hours after delivery, independently scheduled. Frozen suites and evidence survive branch deletion; reruns recreate isolated state.

## Acceptance evidence required before claiming Track B complete

| Area | Required evidence |
| --- | --- |
| Naïve integration | Real structured-output session for each of the four roles; IDs, versions, result validation, and usage recorded. Mocks alone do not pass. |
| Trace Audit | A transcript containing a false success claim yields a finding tied to the actual claim and tool evidence; successful and ambiguous traces do not become invented confirmed failures. Investigator recheck is exercised. |
| Input handling | Text/JSON limits, malformed input, untrusted instructions, and output-schema failures are handled without executing customer content. |
| Commercial | Fixed $5/$10 pilot quotes, clarification for unsupported scope, no invented deliverables, and outreach remains draft-only until approved by a founder. |
| Text Eval | Twelve reviewed/frozen scenarios, explicit code checks, labeled rubric judgments, no-reference factual limitation, and at most three candidate failures repeated once. |
| Target transport | Tests cover private/reserved IPv4/IPv6, mapped addresses, mixed DNS answers, rebinding, redirects, timeouts, response limits, malformed completions, and secret redaction. |
| Calendar | Buggy/fixed fixtures distinguish conflicts, duplicates, cancellation/rescheduling, permissions, time zones, and false success after tool failure. SQL adapter and state grading are exercised against PostgreSQL, not only an in-memory substitute. |
| Isolation | Scenarios and versions cannot read or mutate each other's calendar state; reset/replay preserves original execution evidence. |
| Bounds | Six tool rounds maximum, two concurrent target requests, 30-second target timeout, bounded reproductions, and budget exhaustion pauses without hidden retry spending. |
| Recovery | Restart after session creation and between phases does not duplicate sessions or reports; ambiguous creation is explicitly escalated; concurrent budget reservations cannot exceed the cap. |
| Artifacts | Findings link to scenario/evidence IDs; Markdown/JSON exports are valid, optional HTML is escaped, credentials are absent, and small comparisons make no statistical-significance claims. |
| Live path | An authorized external endpoint and real Naïve SDK are exercised. Clearly separate external customer evidence from internal fixtures. |

## Available durable service entry points

These are server-side modules for Track A to construct after authorization, not
deployed routes. Migrations are artifacts and have not been applied to cloud storage.

| Capability | Entry point | Required durable dependency |
| --- | --- | --- |
| Agent execution | `agents/session-service.ts` | PostgreSQL task CAS and aggregate job/role budget ledger from `agents/postgres-ports.ts` |
| Text execution/replay | `evals/integration/index.ts` | `PostgresTextCheckpointStore`, authorized target/judge resolver |
| Calendar execution/replay | `evals/calendar-integration/index.ts` | Checkpoint store, session-safe journal pool, authorized branch/suite resolver |
| Calendar reports | `reporting/calendar.ts` | Completed rich `reportInput`; preserves incomplete status and full evidence |
| Data acquisition | `evals/data/index.ts` | `createPostgresEvaluationDataStore(db, {tenantId, jobId, knownSecrets})`; trusted scope per job |
| Candidate generation/registry | `evals/data/adapters/index.ts` | Durable agent runner, authenticated reviewed source registry and cost upserts |
| Private progress chat | `reporting/chat/index.ts` | PostgreSQL conversation port, authenticated subject and authorized progress projection |
| Progress projection | `reporting/chat/projection/index.ts` | Authorized durable inventory and consistent scoped reads; no external calls |
| Public candidate discovery | `evals/data/discovery/index.ts` | Configured MediaWiki origin/queries and `createPostgresDiscoveryOperations` with authenticated scope; candidates require permission and quality review |

Follow each module's handoff document for its separate optional migration. In particular,
data acquisition uses `evals/data/persistence-migrations/001-evaluation-data.sql` in
application storage. Factory construction does not authenticate a caller: Track A must
derive tenant/job/subject from trusted server state and reject cross-job requests before
injecting closures. No connection strings or target keys belong in artifact metadata.

The data registry remains configured discovery. A separate bounded MediaWiki retrieval
adapter supplies public candidates with revision provenance; it has not yet been validated
against a live public service. Expert requests remain unsent drafts. Text design admission now quarantines unsupported
literal objectives from the first live fixture. A new live quality check is still required
before considering suite design accepted; syntactic admission alone does not establish
semantic coverage or customer suitability.

## Scope sequencing

1. Trace Audit and real Naïve sessions, integrated with Track A's unpaid job-to-report path.
2. Text evaluation and secure connection checks, then paid end-to-end integration owned by Track A.
3. Calendar simulator and reproducible findings.
4. Comparison and monitoring execution when the earlier gates pass.

The plan permits cutting comparison, monitoring, then calendar if necessary, but a cut must be reported explicitly rather than marked implemented. Track B completion claims must distinguish implemented/tested services, live-provider checks, and Track A integration still pending.

### Additive context adapters (Track A 612f5de)

Track A now supplies optional `ctx.sessions`, `ctx.budget` and `ctx.artifacts`. Its session adapter is keyed by an existing provider session ID, while Track B requires a durable task intent before that ID exists, request identity checks and CAS leases. Its budget adapter is per-job reserve/release, while Track B requires idempotent task reservations spanning both job and role-period caps and measured settlement. These interfaces are not interchangeable: construct `AgentSessionService` with the Track B PostgreSQL task/budget ports and map records/costs explicitly. Do not fall back to creating another session when `findResumable` returns null, nor assume `ctx.budgetMicroUsd` authorizes spend. Coordinate stage reservations and task reservations to avoid charging or reserving the same work twice. `ctx.artifacts` can persist frozen suites/evidence only after authorized job binding; retain names/pathnames rather than public URLs.
