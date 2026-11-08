# Track B Naïve runtime architecture and wiring handoff

Inspected 2026-11-07 in isolated branch `t3/naive-agent-runtime`. Baseline:
`PLAN.md`, `TRACKS.md`, `docs/TRACK_B_INTEGRATION.md`, `track-b-bootstrap.md`,
`track-b-agents.md`, and `track-b-agent-persistence.md`. ECC was not enabled.
Ownership for this change is agents, this document, and the new architecture tests.
No provider/cloud calls, secret access, spending, outreach, push or PR occurred.

## Required architecture versus optional scope

The required execution model is **Track A Workflow calling Track B services**.
Four separate role configurations, structured output validation, session identity,
durable task intents, bounded recovery, aggregate reservations, and honest usage
accounting are required. A Naïve team/coordinator, multiagent handoffs, wallets,
and USDC are explicit stretch/out-of-scope items in PLAN sections 3 and 10.
Do not enable autonomous team tooling to satisfy the four-role requirement.
Comparison, monitoring and then calendar may be explicitly cut in that order;
otherwise their stated behavior remains an integration obligation. A scope cut
is not evidence of implementation.

## Runtime audit

| Requirement | Actual local implementation / limit |
| --- | --- |
| Commercial | `commercial.ts`: qualification, clarification, code-owned fixed quotes and draft-only outreach. No sender or inbox is provisioned here. |
| Engineer | Role instructions/configuration in `roles.ts`; design/revision consumers live in evals and are owned by the other team. A role definition alone does not prove twelve accepted tests. |
| Investigator | Role definition requires evidence and test-defect notes; trace/text/calendar consumers live in evals. No objective result override authority is granted by the runtime. |
| Operator | `operator.ts` writes constrained report summaries and retest/monitoring language. This module does not expose separate readiness/daily-log/follow-up task APIs; private chat/report integration belongs to other owners. No claim of the full operator product flow. |
| Provider configuration | `provision.ts` denies tools, MCP, skills and handoffs, sets model and role period/task caps. `ensureAgents` reuses an existing agent by name/version; it does not audit that agent's actual tools, model or budget settings. Deployment must verify existing versions before trusting them. |
| Structured output | Every create body requires `output_schema` and `structured_output_required`; `session-service.ts` validates terminal and replayed results with the caller's Zod schema. Idle without a valid document is not success. |
| Persistence | `postgres-ports.ts` stores intent/request/key before dispatch, CAS revision/leases, session ID, version, output, usage and errors. Apply its separate SQL migration in application storage; construction does not apply it. In-memory/file diagnostic ports are not deployed durability evidence. |
| Budgets | Atomic SQL reservations span job plus role-period scope. $3 single/$5 comparison default job caps; role caps $35/$65/$65/$35. Role task ceilings and per-task budgets are explicit. Measured overage is retained and blocks later dispatch; unknown usage retains the reservation. |
| Recovery | Known IDs are polled; expired create leases go through ambiguity recovery. Metadata lookup precedes bounded same-body/same-key replay. Duplicate sessions, unresolved ambiguity and inaccessible saved sessions require an operator. Changed request under the same task identity is blocked. |
| Costs | Durable task rows retain measured costs for both success and unsuccessful terminal tasks. Existing eval adapters deliver returned costs; the new runner composition also delivers before returning. No claim of exactly-once external delivery without a durable sink. |
| Missing/invalid usage | New guard escalates invalid/absent/fractional/unsafe/negative monetary usage or invalid token counts before settlement. It preserves session identity, holds the reservation and emits no measured cost. Valid measured zero is still delivered. |

`session-service.ts` does not determine Workflow state transitions, send alerts,
write founder interventions or authorize jobs. Track A must translate
`budget_exhausted`/`budget_paused` into `paused_budget`, persist the reason, and
alert the operator. Pending tasks must re-enter with the same request; operator
blocks must stop. Never increment `attempt` automatically after a storage or
provider failure. Manual recovery of invalid usage requires reconciliation of
the saved session and held reservation, not a replacement task.

## Implemented composition

`agents/runtime.ts` now exports:

- `withAgentCostDelivery(runner, sink)`, a narrow decorator for an existing durable runner.
- `createPostgresAgentRuntime(deps)`, which composes the SQL task/budget adapters,
  `AgentSessionService`, and the cost decorator without environment reads or I/O.

The parent also exports these factories and `AgentCostSink` from the server-only
`evals/index.ts` entry point. Parent verification reran strict types with all 16
architecture tests and 122 agent tests against Track A `eee9939`; all passed.

The factory requires the SQL transaction port and cost sink explicitly. It never
falls back to memory, provisions agents or introduces a job orchestrator. The sink
receives `naive:<provider-session-id>` and the original measured `CostEntry`.
This key intentionally matches `evals/service-adapter.ts::toContractCost`.

Delivery is at least once: a sink failure propagates and prevents success from
being returned to the caller. Retrying the exact task reads the committed task
outcome and redelivers without creating/polling another session or reserving more
money. An acknowledged commit followed by a lost response is safe **only when the
sink atomically deduplicates**. There is no separate local delivery flag that could
lose costs between two commits. Background reconciliation of abandoned Workflow
invocations is still an app responsibility; this is not a background outbox worker.

The sink must commit by the provided key, reject conflicting job/session/role/
purpose/amount identity, and preserve first-write metadata. Do not deduplicate with
an in-memory Set or a read-before-insert race. Unknown costs remain unknown; this
runner does not estimate AI Gateway, customer-provider, hosting or revenue values.
It delivers every *measured* terminal cost, including schema failure, budget pause,
provider failure and an input-request stop. Pending or ambiguous creation has no
measured cost to deliver. Held budget is not measured spending.

## Actual Track A seams (read-only local ref)

Inspected local `origin/track-a` at
`eee9939b290190886fa9aa11fd32ff84442f05f2`; no fetch or writes to that ref.
This supersedes older SHA references in existing handoffs for this inspection.

1. `packages/core/src/integration/eval-services.ts::buildAgentDeps` constructs
   `AgentSessionService` using PostgreSQL ports and SDK 0.12.3. It returns only
   `{ runner, resolveJob }`. Replace construction with the new factory **after**
   providing an idempotent sink, or decorate the existing durable runner. Keep the
   authorized job/known-secret resolution at the service boundary.
2. `apps/web/src/server/job-store.ts::recordCost` currently performs a plain insert
   into `costs`. It does not honor `meta.idempotencyKey`. Replayed adapters can
   duplicate costs now. Track A must add database uniqueness/upsert and conflict
   checks; passing this writer directly to the new factory is unsafe. Existing
   eval adapters may also deliver the same cost: both paths must use the SAME key.
3. `ServiceContext.sessions` starts from an existing provider ID; it cannot replace
   pre-create intent/CAS recovery. `ctx.budget` reserves per-job stage budget and
   cannot replace the role-period/job ledger. Coordinate these two ledgers so stage
   reservation is an envelope rather than an additional charge for the same work.
4. `buildAgentDeps` omits `listJobCosts` and `resolveKnownSecrets`; its resolver
   returns `isFixture: false` for every job. Supply the complete authorized cost
   inventory, known-secret policy and trusted fixture provenance. Otherwise reports
   have incomplete costs, opaque keys lack explicit screening, and fixture identity
   is lost. Never select secrets or jobs from customer-supplied identifiers alone.
5. The app pool has `max: 5` but no explicit connection/statement/lock deadlines.
   Supply bounded deadlines and verify pinned transaction behavior with the actual
   deployed connection mode. A Neon HTTP query function is not this SQL contract.
6. `integration/compose.ts` wires qualify/auditTrace/renderReport, target checking,
   and branch lifecycle. It still throws unavailable for designSuite/runSuite/
   investigate/rerunFinding/proposeAndVerifyFix. The remediation comment in that
   ref is historical relative to other teams' work; their engines still need
   explicit composition rather than a silent mock fallback.
7. `apps/web/src/server/services.ts` maps Track B pending to Workflow retry and
   blocked/configuration/unavailable to fatal errors. Preserve those mappings.
   `EVAL_SERVICES=real` is explicit; the default remains labeled mocks. None of
   these source observations establishes deployed real mode or route authorization.

### Wiring artifact for Track A

Illustrative server composition, after authorization and durable sink implementation:

```ts
import { createPostgresAgentRuntime } from '../agents/runtime';
import { toContractCost } from '../evals/service-adapter';

const runner = createPostgresAgentRuntime({
  naive, db: pinnedSql, directory: verifiedDirectory,
  budgetPeriodId: stableBudgetPeriod, idempotencyNamespace: deploymentNamespace,
  workerId: invocationId,
  costs: {
    async record(key, entry) {
      // Server-owned operation. Atomically bind key to entry.jobId and exact
      // measured identity; reject conflicts. Never use the current request's job
      // as a substitute for entry.jobId. This upsert must be implemented by A.
      await upsertAuthorizedJobCost(entry.jobId, key, toContractCost(entry));
    },
  },
});
return { runner, resolveJob, resolveKnownSecrets, listJobCosts };
```

Use stable namespace/role-period configuration across redeploys, all four verified
agent IDs/versions, and application-storage migrations. Do not rotate period IDs
per invocation to regain spending capacity. Unpinned provider versions can change
between creation and replay; pin versions for reproducible jobs. Naïve's monthly
agent caps and the application hackathon period must both be understood.

## Verification and remaining acceptance

Run without live keys:

```sh
npm ci --prefix tests/track-b --workspaces=false --ignore-scripts
node tests/track-b/naive-architecture/run.mjs
npm --prefix tests/track-b run check -- --components agents --track-a-ref origin/track-a
```

The new harness stages a temporary source copy, runs strict TypeScript, and runs
16 architecture tests. It exercises real PGlite SQL task/budget adapters with a
fake provider and a test SQL cost sink. Coverage: all four roles, restart/replay,
lost sink acknowledgement after commit, unsuccessful measured outcomes, ambiguous
create recovery, invalid monetary/token usage, measured zero, measured overage,
held/exhausted budgets, and changed-request refusal. PGlite tests do not prove
independent-session contention or hosted Neon recovery. Existing agent harness:
122 tests in seven files, strict TypeScript, none skipped. No native PostgreSQL
race tests or live diagnostic were run in this task.

Historical files `tests/track-b/live-evidence/naive-four-roles-2026-11-07.json` and
`naive-replay-2026-11-07.json` record four version-1 fixture sessions and 26,023
micro-USD total. The engineer probe has two scenarios, not a full twelve-scenario
suite; replay records one GET. These are prior fixture artifacts, not independently
revalidated live acceptance, customer evidence or a deployed Workflow test.

Still required outside this owned runtime change: verify actual provider role
versions/configuration and Commercial email identity/inbox; finish rich text/
calendar/remediation/data/chat composition with their owners; apply migrations;
wire durable cost deduplication and complete report costs; authorize routes and
artifacts; deliver an unpaid real-mode Trace Audit through the deployed Workflow;
exercise restart/failure paths and the security/payment gates; then prove a live
payment and real customer-confirmed finding. Outreach still requires founder
approval. Full Naïve/company architecture is **not complete** on this evidence.
