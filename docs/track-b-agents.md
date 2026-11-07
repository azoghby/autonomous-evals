# Track B: agents, Trace Audit, reports

Status (2026-11-07): implemented and fixture-tested. The live Naïve path is partly checked: the four agents are provisioned, but no live session has completed yet (see "Live results").

## Dependencies for `@ae/core` (parent adds these; Track B did not edit manifests)

- `@usenaive-sdk/managed-agents@^0.12.3`: ESM-only; its only dependency is `zod ^4.4.3`. Verified against 0.12.3.
- `zod ^4.6.7` (already present). Uses `z.toJSONSchema`.
- dev: `vitest`, `@types/node`. Tests import `vitest` and `node:fs`/`node:path`.
- Imports are extensionless (`moduleResolution: Bundler`). Uses Web Crypto `crypto.subtle` (Node ≥ 20).

## Files

| Path | Purpose |
|---|---|
| `evals/types.ts` | Provisional contracts and ports (`AgentTaskStore`, `BudgetLedger`, `NaiveSessionsPort`, `RubricJudge`, `TextTargetPort`, `Finding`, `CostEntry`). Move to `contracts/**` when agreed. |
| `evals/pricing.ts` | The fixed price table ($5/$5/$5/$10, $49/month) and `findInventedPrices`. |
| `agents/session-service.ts` | `AgentSessionService.run(spec)`: durable, re-entrant Naïve task runner. |
| `agents/naive-adapter.ts` | The only SDK importer: `createNaiveClient` (30 s per-request deadline), `createNaiveSessionsPort`, `classifyNaiveError`. |
| `agents/roles.ts` | The four role definitions: prompts, period caps $35/$65/$65/$35, per-session maximums, task budgets, default model. |
| `agents/provision.ts` | `ensureAgents`: lists agents first and creates only the missing `ae-*` agents (all tools denied, no handoffs, no MCP). Never touches other agents (CEO). |
| `agents/commercial.ts` | `qualifyRequest`, `buildQuote` (pure, the only price source), `draftOutreach` (always `pending_founder_approval`). |
| `agents/operator.ts` | `writeReportSummary`. Rejects unknown finding IDs, off-menu prices, and profit/revenue/significance/guarantee claims. |
| `agents/redact.ts` | Credential redaction, `containsSecret`, `redactingLogger`. |
| `agents/memory-ports.ts`, `agents/file-ports.ts` | Reference ports for tests and single-process scripts only. Not for production. |
| `agents/live-diagnostic.ts` | Bounded live check: provisions agents, then runs one engine task per role. |
| `evals/trace/{normalize,detect,audit}.ts` | The Trace Audit engine. |
| `evals/service-adapter.ts` | `createTrackBServices(deps)` → `qualify`, `auditTrace`, `auditTraceDetailed`, `renderReport` over Track A's `contracts/` (origin/track-a 673873d). |
| `reporting/render.ts` | `renderReport` → `{ json, markdown, html, summary, monitoringPitch }`. |

## Integration signatures (for Track A Workflow steps)

```ts
import { AgentSessionService } from "@ae/core/agents/session-service";
import { createNaiveClient, createNaiveSessionsPort } from "@ae/core/agents/naive-adapter";
import { createTrackBServices, TrackBPendingError, TrackBBlockedError } from "@ae/core/evals/service-adapter";

const runner = new AgentSessionService({
  naive: createNaiveSessionsPort(createNaiveClient({ apiKey })),
  store,            // Neon AgentTaskStore (below)
  ledger,           // Neon BudgetLedger (below)
  directory,        // agent IDs below
  budgetPeriodId: "2026-11-hackathon",
  idempotencyNamespace: "prod",   // e.g. "prod" / "preview"; keys never expire server-side
  workerId: crypto.randomUUID(),  // per step invocation
  maxWaitMs: 60_000,              // keep below the step timeout; returns pending otherwise
});
const svc = createTrackBServices({ runner, resolveJob: async (ctx) => ({ customerId, package, isFixture, linkedRetestOf, quoteVersion }), listJobCosts });
await svc.auditTrace(ctx, trace, systemPrompt);   // contract TraceAuditResult
await svc.auditTraceDetailed(ctx, trace, systemPrompt); // full result: claims, dismissed, testDefects, investigator status, limitations
await svc.qualify(ctx, intake, clarifications);
await svc.renderReport(ctx, { intake, findings, richFindings, limitations });
```

Error mapping:

- `TrackBPendingError` (`retryable`, `retryAfterMs`) → Workflow `RetryableError`. The step is safe to re-run: the same task key resumes the same session.
- `TrackBBlockedError` (`code`: `paused_budget` | `needs_operator` | `rejected_input` | `agent_failed`) → `FatalError`, and move the job to that state.

The lower-level functions return discriminated unions instead of throwing: `auditTrace`, `qualifyRequest`, `writeReportSummary`, `AgentSessionService.run`.

## Session safety (implemented)

1. Refuse any prompt that contains a known or pattern-matched credential. Nothing is reserved or sent.
2. Reserve the budget atomically across `agent:<role>:<period>` and `job:<jobId>`. The reservation is idempotent on the task key. A refusal returns `budget_exhausted`, with no session and no retry.
3. Persist the intent row (`creating`): the exact request body, a deterministic idempotency key `ae-<ns>-<sha256(taskKey)[0:48]>`, and a 120 s lease.
4. Call `sessions.create(body, { idempotencyKey })` and persist the session ID immediately (`created`).
5. Poll the session. Validate `structured_output` with Zod, then settle the reservation with the measured `consumed_micro_usd`.
   - Schema mismatch, a missing document, or an idle `error` → `schema_failed`. No automatic retry.
   - `budget_paused` → `budget_paused`. `awaiting_*` → `needs_operator`.

Handling of create failures:

| Create result | Handling |
|---|---|
| 4xx (definitive) | `failed`; reservation settled to 0 |
| 429 | Retry later with the same key and the same body. Does not count as a replay. |
| 409 `idempotency_conflict`, 5xx, timeout, network error, unreadable 2xx, expired lease | `ambiguous` (see recovery below) |

Recovery for `ambiguous` tasks:

1. Look the session up with `sessions.list({agent_id})` and match `metadata.ae_task_key`.
2. Exactly one match: adopt it.
3. More than one match: `needs_operator` (`duplicate_sessions`).
4. No match: replay the stored body with the stored key. The API deduplicates replays. At most `maxReplays` (default 2) replays.
5. Still unresolved: `needs_operator` (`ambiguous_create_unresolved`).

A fresh key is never generated for an existing task. A deliberate new attempt means a new `attempt` number, which is an operator decision.

## Ports Track A must implement on Neon

`AgentTaskStore` uses table `agent_tasks`, which is richer than the current `agent_sessions` table. The columns map 1:1 to `AgentTaskRecord`:

- Key and versioning: `task_key` PK, `revision` int.
- Identity: `job_id`, `role`, `purpose`, `attempt`, `agent_id`, `state`.
- Request: `idempotency_key` unique, `request_body` jsonb, `reservation_id`, `budget_micro_usd`.
- Session: `session_id` unique nullable, `agent_version`, `consumed_micro_usd`, `token_usage` jsonb, `result` jsonb, `error` jsonb.
- Recovery: `replay_count`, `lease_owner`, `lease_expires_at`.
- Timestamps: `created_at`, `updated_at`.

The two writes it needs:

- `insertIfAbsent`: `INSERT … ON CONFLICT (task_key) DO NOTHING RETURNING *`, then fall back to `SELECT`.
- `compareAndSet`: `UPDATE … SET …, revision = revision + 1 WHERE task_key = $1 AND revision = $2 RETURNING *`.

`BudgetLedger`: the current `budget_reservations` table has no scopes, idempotency, or settlement, so extend it. Reference SQL, run in one transaction:

```sql
-- budget_scopes(key text pk, cap_micro_usd bigint)
-- budget_reservations(id text pk, job_id, scope_keys text[], reserved_micro_usd bigint, settled_micro_usd bigint null, created_at)
BEGIN;
SELECT 1 FROM budget_reservations WHERE id = $id;                     -- exists → return replay ok
INSERT INTO budget_scopes(key, cap_micro_usd) VALUES … ON CONFLICT DO NOTHING;
SELECT key, cap_micro_usd FROM budget_scopes WHERE key = ANY($scopes) ORDER BY key FOR UPDATE;  -- lock in key order
SELECT COALESCE(SUM(COALESCE(settled_micro_usd, reserved_micro_usd)),0) FROM budget_reservations WHERE $scope = ANY(scope_keys);  -- per scope
-- if any cap - committed < amount: ROLLBACK, return {ok:false, exhaustedScope, available}
INSERT INTO budget_reservations(id, job_id, scope_keys, reserved_micro_usd) VALUES (…);
COMMIT;
-- settle: UPDATE budget_reservations SET settled_micro_usd = $c WHERE id = $id AND settled_micro_usd IS NULL; (0 rows → return existing)
```

Cost recording: `ctx.recordCost` receives `meta.idempotencyKey = "naive:<sessionId>"`. Insert it at most once (add a unique index), because re-run steps report the same session again.

## Contract extension needs (proposed; not yet agreed)

1. `ServiceContext` needs the durable `AgentTaskStore` and `BudgetLedger`, or `createTrackBServices` must stay the injection point. `budgetMicroUsd: number` is not a reservation and is ignored.
2. Add non-terminal results (`pending`, `paused_budget`, `needs_operator`) instead of exceptions, or keep the two error classes above as the agreed contract.
3. `TraceAuditResult` should carry `dismissed`, `testDefects`, `investigator.status`, `limitations` and `claims`. Until then, persist `auditTraceDetailed` output.
4. `Finding` lacks `basis` (objective / heuristic / agent / judge). The adapter writes it into `description`. Rendering contract-only findings shows no basis.
5. `RunResult.results[].passed: boolean` cannot express infrastructure errors, judge failures, or not-assessed factual checks. Text Eval needs `status: pass | fail | error | not_assessed`, with objective and rubric results kept separate.
6. `CostEntry.jobId` is a UUID. Track B scopes also use non-UUID IDs for internal jobs (`outreach-<prospect>`, `live-diag-*`).

## Trace Audit behaviour

- **Input:** at most 200 KB of UTF-8 bytes; larger input is rejected, never truncated. At most 4,000 events, and the system prompt is limited to 20 KB.
  - Accepted formats: OpenAI chat, Anthropic blocks, Responses items, JSONL, and plain text with role prefixes (including `TOOL name(args): result`).
  - Credentials are redacted before analysis.
- **Claims:** only assistant sentences count; quoted text, hedged statements, and future-tense statements do not.
- **Evidence:** the latest relevant action in the turn decides the claim's evidence status (`supported`, `contradicted`, `unclear_error`, `no_result`, `no_evidence`).
  - A failed attempt followed by a successful retry counts as supported.
  - A missing result means "unsupported by the provided log", never "failed".
- **Other detectors:** ignored tool errors, unsafe actions (rm -rf, DROP/TRUNCATE, unscoped DELETE, force push, curl|sh, chmod 777, disabled verification, leaked credentials), and protected terms in prohibitions.
- **Investigator:** receives untrusted data JSON-escaped (`<` → `<`) inside `<untrusted_data>`.
  - A citation is accepted only if it is verbatim in the cited event.
  - Verdicts with fabricated quotes are voided.
  - Extra findings from the investigator are capped at `rubric_concern` and kept only if verified.
  - Dismissing an objective check leaves it `inconclusive`, plus a test-defect record if a note was given.
  - If the investigator is unavailable, every item is `inconclusive`.

## Tests (fixtures; they do not prove the live path)

**67 tests passing:** run from a temporary harness that combines `agents/ evals/ reporting/` with origin/track-a `contracts/`, typechecked with strict + `noUncheckedIndexedAccess`.

- `agents/__tests__/session-service.test.ts` (19): persistence, restart resume, credential refusal, schema/no-document/error/budget-pause/question outcomes, definitive rejection, job and role caps, a 20-way concurrent reservation race, and ambiguous-create recovery (lookup, same-key replay, escalation, lease expiry, rate limit, unreachable API, duplicates, two-worker race).
- `agents/__tests__/naive-adapter.test.ts` (4): the real SDK client with an injected fetch (idempotency header, body, mapping) and error classification.
- `agents/__tests__/commercial-operator.test.ts`, `reporting/__tests__/render.test.ts`, `evals/__tests__/service-adapter.test.ts`.
- `evals/trace/__tests__/trace-audit.test.ts`: covers all 10 cases in `tests/track-b/trace-acceptance.json` (main), plus a compromised investigator, fabricated citations, schema failure, budget pause, end-to-end through the session service, input limits, formats, redaction, and tag escape. The corpus path is `TRACE_ACCEPTANCE_PATH`, or by default the repo root.

**Not yet written:** PostgreSQL implementations of the two ports and their concurrency test (Track A owns the schema), and a mutation-style check that each test fails when its guard is removed.

## Live results (2026-11-07, SDK 0.12.3, model `zai-org/GLM-5.2-FP8`)

- Authentication works. The CEO agent `agt_ypvrh8wt7j60cc7910cs38c30t` was not modified.
- Four agents were created (version 1, tools denied, monthly caps):

| Role | Agent ID | Name | Monthly cap |
|---|---|---|---|
| Commercial | `agt_8qs08dagxf8jyyj76afczxrdhp` | `ae-commercial` | $35 |
| Evaluation engineer | `agt_gwht2ygfm04s2j19062q3r5sad` | `ae-evaluation-engineer` | $65 |
| Quality investigator | `agt_p2r9zh605pmpzvx4fdprd832vt` | `ae-quality-investigator` | $65 |
| Company operator | `agt_46gdd6aqq1vtzcvvtnrtnyqk7j` | `ae-company-operator` | $35 |

- **Sessions:** none were created.
  - All four `sessions.create` calls (`budget_micro_usd` 100,000) were refused with HTTP 402: `budget_exceeded: the remaining budget for this task is below the pre-flight quote`. Naïve's documentation treats this error as terminal.
  - Spend: $0. All four reservations were settled at 0, and the tasks are recorded as `failed` (state file `/tmp/trackb-live/state.json`, outside the repo).
  - Task keys: `live-diag-20261107a:<role>:<purpose>:1`. Idempotency keys: `ae-livediag-12d163fa…`, `ae-livediag-c016ebaa…`, `ae-livediag-1aa19a4b…`, `ae-livediag-d3fb45bd…`.
- **Blocked check:** a completed structured-output session per role. It needs one of two choices:
  - (a) raise the per-session cap above the pre-flight quote. That quote is undocumented and probably depends on the model's maximum output; try ≈ $0.25–0.50 within the role maximums ($1–1.5).
  - (b) switch the four `ae-*` agents to a cheaper model, e.g. `z-ai/glm-5.3-flash` (the CEO's model) or `openai/gpt-oss-20b`, then rerun with a new `runId`.

  To rerun, call `runLiveDiagnostic({ client, stateFile, runId: "<new>", perSessionMicroUsd, totalMicroUsd })` from a script that reads the key from the private file inside the process.

## Not done in this slice

- **Text Eval:** not started. A suite review/freeze service, objective checks, the rubric mapping onto `createGatewayJudge` (`RubricJudge` type), and the no-reference limitation are designed (types exist) but not implemented.
- **Live engine validation:** none, beyond provisioning.
- **Version comparison and monitoring execution:** not in this slice.
- **Claim detection limits:** pattern-based and conservative. It misses success claims phrased without the lexicon, or joined to a hedge in the same sentence.
