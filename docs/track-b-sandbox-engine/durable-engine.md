# Durable sandbox engine composition

Base: `414eff55dc74164ec7b19e7dea3b7cb674aa2ccc`. Offline integration only; no app/runtime adoption, migration execution against cloud databases, provider acceptance, spend, or production readiness claim.

## Server construction

```ts
import { createDurableSandboxEngine } from '../../../packages/core/src/evals/sandbox/persistence';

const engine = createDurableSandboxEngine(engineConfig, {
  db, // AgentTransactionalSql; commit before resolving, no callback retry
  scope: { tenantId: customerId, jobId, environmentId },
  authorize, // current principal + ownership + job/environment binding on EVERY operation
  knownSecrets, // include revoked credentials to retain historical coverage
});
const report = await engine.run(approvedTrialRequest);
const saved = await engine.readPrivateReport(trialId, report.execution.identityDigest);
```

`engineConfig.authority` supplies current engine authorization and finalSnapshot. The composition owns whole-engine replay, gate replay, generation binding, and private report writes. It refuses mismatched customer/job/environment scope at construction. It uses the existing `text_integration.checkpoints` migration/transaction adapter with permanent scoped claims. A failed or interrupted effect remains pending for reconciliation; no lease expiry or takeover redispatch. Report writes are immutable atomic upserts, so a lost write acknowledgement can replay the completed engine result and retry storage without rerunning tools. Read/report/replay boundaries retain authorization, envelope/digest/identity validation, payload bounds, and secret screening.

The caller still supplies trusted execution checkpoints/runtime, SQL snapshots, approval resolution, and media bridge/transport authorities. This adapter does not provision those or supply production credentials. The outer integrated-trial SQL fence commits before any execution/media callback, so interrupted media work cannot cause a second engine dispatch. Media subordinate authorities remain explicit; tests use local file journals and fake external transports. Never use the private report API as a public DTO.

## Report validation and compatibility seam

The report schema remains `sandbox-private-report-v1`. Every media container has explicit strict receipt/voice fields; unknown object fields are rejected. Only evidence values intrinsically defined as arbitrary JSON (tool arguments/results, SQL row/outbox records) retain opaque JSON semantics, with the existing exact-JSON boundary rejecting accessors, hooks, sparse arrays, nonfinite numbers, cycles, symbols and undefined values.

Validation binds execution input/job/environment hashes; report outcome scenario/trial/seed/variant/versions; grade run/scenario/versions/transcript/tools/diff; and report money. Media reports additionally bind deterministic fixture and agent-version hashes, receipt target config/model/asset/operation IDs, oracle expected/read fields and injection canary, deterministic receipt perception and latency statistics, voice input-audio/oracle/model/reply/tool evidence, and modality. Completed media execution requires evidence; unresolved execution may have null media. Unknown cost remains null.

The outer engine replay identity includes the trusted media plan (via the engine's mediaPlanIdentity), input, suite and approval. Receipt artifact `identityDigest` also depends on original bounded media input (maxBytes/timeouts) not retained in its evidence; standalone report reads validate its hash shape and envelope integrity, while exact request/plan binding is enforced by whole-engine replay. Audio/image bytes are not stored in these reports, so validation checks cross-evidence hashes rather than claiming to rehash absent binaries. Voice plan fact-map keys and latency budgets likewise remain trusted configuration; the schema does not claim independent acoustic verification.

Legacy rows without media/policy metadata remain valid and receive no default fields or rewritten values. Validation returns the original JSON value after checking the parsed digest, preserving direct validation bytes/property ordering. Existing historical text outcome fixtureHash/agentVersion fields keep their prior format; deterministic recomputation is added for media reports. PostgreSQL JSONB does not preserve textual key order: SQL roundtrips promise exact JSON values and canonical report digest, not literal JSON source formatting.

The engine currently emits one known optional JS field, receipt `oracle.injection: undefined`, for non-injected receipts. Only the composition omits this optional field before storage; its JSON wire representation is absent. The raw persistence API remains strict and does not silently JSON-roundtrip arbitrary unknown objects.

### Outcome team's precise additive contract

Reader fields are optional only as an all-or-none historical compatibility group:

```ts
outcomeRule?: 'sandbox-quality-outcome-v2';
qualityCostPolicy?: { version: 'sandbox-quality-cost-policy-v1'; maxCostMicroUsd: number } | null;
policyDigest?: string; // SHA256 canonical { outcomeRule, qualityCostPolicy }
```

When any field is present, all three are required. The cost cap must be a nonnegative safe integer; policy objects are strict; policyDigest must match exactly. No policy is null, never an invented zero cap. No new fields are added to historical records. Schema policy checks do not assert a settled cost or choose outcomes: integration/outcome code owns quality/cost attribution.

Trusted approval may carry the same nonnullable optional qualityCostPolicy. Gate evidence may add executionRule `sandbox-gate-execution-v2` and qualityCostPolicy, and its binding changes when those fields are present. These are gate/approval contracts, not nested private report fields. This adapter stores gate results under exact replay/envelope digests without projecting or stripping their metadata. The outcome team owns admission validation and integrated-trial identity changes (full approval, outcomeRule, policyDigest) so changed policy conflicts under the same trial replay key before dispatch. No integration/index.ts, generation/gates.ts, continuation, grading, or gate-bridge edits are included here.

## Verification

Commands use retained local dependencies; they do not install packages or call providers:

```sh
node tests/track-b/sandbox-persistence/run.mjs
node tests/track-b/sandbox-durable-engine/sql-run.mjs
```

The existing runner now stages all exact Track A sandbox modules at 414eff5 (79 files) and installed AI SDK dependencies needed by transitive media imports. Overrides: TRACK_A_REF, TRACK_B_NODE_MODULES, TRACK_B_IPADDR_MODULE, SANDBOX_PERSISTENCE_RUNTIME. Defaults refer to this machine's retained /tmp dependencies; a fresh machine must supply them offline. Original persistence test source is unchanged.

Verified: strict staged TypeScript plus 14 original native PostgreSQL 18.6.0-beta.19 assertions, independent SQL connections, new workers and full database stop/start, zero skipped. Separately: strict staged TypeScript plus seven new tests (three actual-engine SQL lifecycle tests and four schema/policy tests), zero skipped. Engine execution uses real local PGlite SQL/runtime helpers, actual engine/grader/media SDK serialization, fake external responses, immutable pre-disposal snapshots, and reopened database directories. Restart replaces runtime/snapshot ports with throwing implementations and verifies unchanged dispatch/tool counts and canonical report digests. Receipt admission uses a trusted protocol fixture for the existing null-control perception seam; this does not claim end-to-end receipt gate acceptance. Negative checks cover scope/authorization/approval/identity conflicts, malformed/unknown media fields, cross-evidence corruption and policy digest/partial metadata.

Repository-wide commands were attempted as instructed: `npx tsc -p apps/web --noEmit` cannot run because the checkout has no TypeScript dependency installed (npx resolves the unrelated tsc package); `npm test` fails because vitest is absent. No app build pass is claimed. Staged strict compilation and the focused offline suites provide the scoped evidence above.

## Owned-work log

- Added scoped actual-engine composition, explicit media schemas/bindings, additive policy compatibility and legacy-value preservation.
- Added disjoint native-child SQL engine verification tests; repaired only the existing native runner's source/dependency staging, preserving its 14 tests.
- Re-ran both focused suites after final schema changes: 14 native plus seven engine/schema tests passed. Root checks remain blocked as recorded above.
- Ownership excludes root LEDGER.md; this log records the change under the explicitly assigned documentation path. No push, deployment, provider calls, or cloud changes.

## Parent combined verification

After integrating outcome policy `354d7f3`, parent verification passed strict staged TypeScript and all seven durable-engine/schema tests against current A `6b9ee17`. The receipt assertion now expects quality pass with null money under no cost gate; voice remains unknown because its perception evidence does not pass. The tests assert the emitted outcome rule and policy digest, then reopen SQL and compare the complete report without redispatch. The initial combined run exposed this outdated expected outcome; no production rule was weakened to satisfy it.

The repaired original persistence runner also passed all 14 native PostgreSQL checks against `a0d24f6`, including independent connections and full server restart. Separately, parent receipt admission passed strict compilation and 22 tests against `01c0507`. These are scoped offline results, not hosted acceptance. Generation continuation is now available as a separate factory (`6b9ee17`); adopting it inside engine generation with legacy-claim protection is still in progress.
