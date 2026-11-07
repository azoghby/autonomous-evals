# Track B production data adapters

Import the new entry point `packages/core/src/evals/data/adapters/index.ts` directly. Existing data exports, types, application contracts, manifests, and target transports are unchanged. These are server-side adapters; configuration and persisted review records must come from authenticated private infrastructure, never client JSON, source instructions, or model output.

## Production wiring

```ts
import { AgentSessionService } from '../agents/session-service';
import { acquireEvaluationData } from '../evals/data/acquisition';
import {
  createNaiveGenerationAdapter, createVerifiedRegistryAdapter,
  createDraftOnlyExpertAdapter, mapApprovedDataToTextDesign,
  frozenDataReference, projectDataBlockers,
} from '../evals/data/adapters';

// Supply existing Naive SDK sessions port, durable AgentTaskStore/BudgetLedger,
// provisioned role directory, namespace, period, worker ID and bounded polling.
const runner = new AgentSessionService(agentSessionDeps);
const registry = createVerifiedRegistryAdapter({
  registryId: 'public_registry_v1',
  entries: verifiedRegistryEntries, // Array<{ task: DataTaskSpec; data: DataBatch }>
  maxSources: 20, maxCases: 24, maxContentChars: 80_000, knownSecrets,
});
const generate = createNaiveGenerationAdapter({
  runner, job, sessionCapMicroUsd: 100_000, jobCapMicroUsd: 500_000,
  maxCases: 24, maxInputBytes: 80_000, knownSecrets,
  onMeasuredCost: async ({ operationKey, taskKey, cost }) => {
    await measuredCostStore.upsert({ operationKey, taskKey, cost });
  },
});
const expert = createDraftOnlyExpertAdapter({ drafts: expertDraftStore, knownSecrets });
const task = await acquireEvaluationData(spec, initialBatch, {
  store: evaluationDataStore, ...registry, generate, expert, knownSecrets,
});
const mapping = mapApprovedDataToTextDesign(task, {
  job, versionLabel: 'v1', systemPrompt: null, knownSecrets,
});
// Only mapping.status === 'ready' permits designTextSuite(mapping.designInput, ...).
// After design completes, persist frozenDataReference(task, suite, sameContext)
// alongside the suite and its digest, in authorized private evidence storage.
```

The names `agentSessionDeps`, `job`, `verifiedRegistryEntries`, `measuredCostStore`, `expertDraftStore`, `evaluationDataStore`, `spec`, and `initialBatch` are explicit application dependencies, not new globals or provided services. Provision the generation agent without network, messaging or external-action tools; prompt restrictions alone do not revoke provider tools. `job` is the existing complete `JobRef` (including customer, environment, package, fixture status, quote version and linked retest). Text mapping requires package `text_eval` and matching job/task scope. Start with an empty initial batch unless an authenticated adapter supplied it. Passing client-controlled initial approvals bypasses the intended trust boundary of the existing acquisition API.

## Interfaces and guarantees

`createNaiveGenerationAdapter(NaiveGenerationConfig)` implements `EvaluationDataPorts.generate`. It runs role `evaluation_engineer` with purpose `data_generate_<sha256(operationKey)>`, attempt 1. The resulting task key is `<jobId>:evaluation_engineer:<purpose>:1`. Reinvoke with identical input to resume; never increment attempts to recover an ambiguous call. Production requires the existing `AgentSessionService` with durable task storage and atomic budget ledger; an arbitrary injected runner cannot provide durability by itself. Changed inputs under the same operation key fail the service's persisted request identity check.

Both caps are positive safe integers in micro-USD; the session cap cannot exceed the job cap or role ceiling. Defaults are 24 candidates and 80,000 UTF-8 input bytes; hard maxima are 100 and 100,000. Candidate inputs/answers are each bounded to 4,000 characters. The strict output envelope is `{cases:[{id,input,requirementIds,sourceIds,expectedAnswer?}]}`. Unknown fields (including verification, review, synthetic overrides), duplicate IDs, existing case collisions, unknown requirements/sources, secrets and PII are rejected. No new sources are generated. Every output case is code-labeled synthetic with generator task-key lineage. The acquisition workflow subsequently retains its existing operation-key generator lineage. Neither identity is an independent factual reviewer.

`onMeasuredCost({operationKey,taskKey,cost})` is awaited for measured terminal costs before candidate admission, including measured failure/schema/budget-pause costs. Its sink must durably upsert by task key/provider external ID; replay calls it again. Preserve actual measured overages; do not replace usage with the requested ceiling or add replay costs twice. Pending returns pending; terminal runner failures throw and the existing acquisition workflow records generic waiting state. Missing measured cost on a completed outcome fails closed. Callback failure prevents candidate admission and can be retried under the same durable task. Budget reservations/settlement remain the runner's responsibility.

`createVerifiedRegistryAdapter(VerifiedRegistryConfig)` returns `discover` and `reviewCandidates`. Required configuration: registry ID, task-scoped entries containing full `DataTaskSpec` and `DataBatch`, source/case/content caps; optional known secrets. Entries are cloned at construction. Hard limits are 100 entries, 100 sources and cases per entry, and 100,000 aggregate source content characters per entry, also subject to the existing 500,000-character safety screen. Every source must be public-origin, integrity-hashed, HTTPS, explicitly permissioned for required uses and independently reviewed; cases must pass the existing quality gate. Factual answers need existing independent-evidence or qualified-consented-expert verification. Registry entries may have incomplete coverage but cannot contain invalid candidate records. Unconfigured tasks return an empty batch; reusing a configured task ID with changed scope fails.

Discovery deliberately emits pending sources and strips answer verification. Only the configured trusted review callback restores approvals, matching full source/case content and lineage, excluding only review/verification fields. Reusing an approved ID with altered text or answers does not inherit approval. Embedded instructions remain inert strings. Reviews must be minted independently before entry into deployment configuration. A registry is not a legal-permission verifier or search engine.

No adapter performs public search, arbitrary URL retrieval, or live discovery. There is no GET retrieval port or new fetch implementation. The existing secure transport is POST-only; it remains unchanged. Registry URLs are provenance metadata, never network destinations. Operators must populate the registry through a separately authorized retrieval/review process with HTTPS, DNS/public-address pinning, redirect rejection, deadlines, byte limits and licensing evidence. Dynamic public-provider search/retrieval remains an integration gap; this implementation chooses the explicitly configured verified-registry option instead.

`mapApprovedDataToTextDesign(task, context)` returns blocked with assessment or ready with `designInput`, accepted IDs, recomputed assessment and a provenance sidecar. It requires persisted ready/complete state, sufficient persisted and recomputed coverage, intersects accepted/approved IDs, and fails on changed acceptance or lost coverage. Only exact independently approved answers enter reference facts; synthetic origin labels remain present. Source content is excluded from reference text, and behavioral cases without verified answers produce null reference text so factual correctness stays unassessed. Such behavioral inputs remain in the sidecar; the current `TextDesignInput` has no separate candidate-case field. References are bounded by the existing 50,000-character schema limit and context by existing prompt/version limits.

The sidecar preserves full accepted case/source records, review/verification, generator lineage, task revision/request hash, timestamp, and SHA-256 binding of records plus reference. Keep it private under the same authorization and retention policy as evidence. Its digest is an integrity binding, not new review authority. `frozenDataReference(task, suite, context)` verifies existing frozen-suite integrity and exact job/version/system/reference equality and returns suite digest plus provenance without changing the frozen suite. Parent integration must persist this sidecar atomically with suite linkage. No schema migration is included.

`projectDataBlockers(task, {id,evidenceRef}, knownSecrets?)` maps both waiting_for_data and waiting_for_expert to existing fixed chat blocker kind `input`; other data states return no blocker. It uses supplied opaque references validated by the existing schema and safety screen. The parent must authorize these IDs, persist projection freshness, and keep the actual job status: acquisition readiness is not a delivered/passing evaluation. No raw source text, URLs, expert identities or arbitrary blocker prose are exported. Returning no data blocker does not establish an unblocked job.

`createDraftOnlyExpertAdapter({drafts,knownSecrets?})` always returns pending after rebuilding and storing an unsent, recipient-free draft from task scope. `ExpertDraftStore.putIfAbsent(operationKey,draft)` must durably deduplicate and reject changed content on replay. Incoming draft authority claims are ignored. There are no sending, contribution polling/approval, hiring, payment or compensation operations. Authenticated expert intake and independent review remain separate integrations.

## Validation and limitations

Fixtures exercise real `AgentSessionService` behavior through fake provider responses as well as adapter rejection paths. All public facts, licenses and reviews in tests are authored fixtures, not claims of fetched sources or live validation. No live provider/cloud calls or spending were performed. Production activation still needs durable application stores, authorization, authenticated registry administration/review, cost upserts, expert artifact storage, orchestration calls and suite/progress persistence. Local fixture success does not validate live Naive connectivity, legal permission, deployment storage or app routes.

Run the existing isolated strict harness (nested dependency install only if needed):

```sh
npm --prefix tests/track-b run check -- --track-a-ref origin/track-a
```

Validation against `origin/track-a` resolved to `afd473788741e480b1e1bdf7728e451b5d47aaed`:

- Scoped `--components evals` check: strict compilation and 194 tests across 16 files passed, none skipped.
- Final full check: strict compilation passed; 627 of 631 tests passed across 46 files. All 26 new adapter tests passed, including the final changed-body replay assertion. Four existing tests timed out at their 5-second limits: simulator acceptance scenarios; branch-ledger durable creation/deletion and ambiguous creation; chat PostgreSQL close/reopen persistence. These files were not changed, and the full suite is not green. No timeout or harness settings were weakened.

The existing harness excludes Track A app tests and uses a maximum of two Vitest workers. Only its nested dependency installation was used. No changes to existing data modules or Track A-owned files were made.
