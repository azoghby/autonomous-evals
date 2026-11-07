# Track B durable progress projection

Server-only entry point: `packages/core/src/reporting/chat/projection/index.ts`.
`createDurableProgressProjection` returns the existing `ProgressPort` (`read`) and
an additional `project` method with exact acquisition and operation states.
`createDurableProgressReader` composes **get-only** existing `TextCheckpointStore`
and `EvaluationDataStore` interfaces inside a caller-supplied consistent view.
It performs no checkpoint claims, CAS, target/agent calls, spending, retries,
report generation or delivery. Construction performs no reads.

Only `reporting/chat/projection/**` and this document are owned by this change.
No ECC, app/routes/UI/contracts/root manifest changes, cloud mutations, push or PR.
One Sol child supplied the disjoint negative-test file.

## Authenticated trusted-reader boundary

Every `read` and `project`, including direct calls outside chat, authenticates
again, compares the authenticated subject with the requested scope, reauthorizes
the job, and resolves an authorized durable inventory. Caller/job substitutions
fail before durable reads. Returned scope, job, key/digest inventory, acquisition
job identity and every cost's job are checked. Fixed `ChatError` messages hide
storage exceptions and retain no driver causes. Chat also authenticates before
conversation replay/history/poll, using its existing service.

This is an **authenticated trusted-reader boundary**, not production application
authorization. Track A must implement the session verifier, owner/operator policy,
tenant/environment binding, database role/RLS policy, and authenticated evidence
resolution. A malicious reader that fabricates a correctly scoped row cannot be
detected by structural checks. Existing checkpoint storage keys by job, not tenant;
resolve a globally unique authorized job and retain the authorized tenant through
all joins. Never accept inventory, digests, tenant, scope or view ports from JSON.
References are identifiers, never capabilities.

`resolve(scope)` supplies the complete inventory of expected operation keys,
input digests, run/suite/branch identities, and expected scenario selection from
trusted persisted job metadata. Do not enumerate only completed rows: omitted
expected work would erase a blocker. `withRead` must recheck authorization and
inventory revision inside its read boundary. Each requested checkpoint/task has
exactly one returned entry, with `null` representing missing storage. Duplicate,
omitted, additional or conflicting rows fail closed. Expected scenario subsets
must be explicitly persisted; partial run arrays cannot silently become a full run.

Use one pinned **read-only REPEATABLE READ** transaction, or an immutable versioned
view, covering job, inventory revision, checkpoints, acquisition and costs. A
persisted consistency watermark covers all those records. Independent
READ COMMITTED reads or separately constructed stores are insufficient. The
existing stores can inspire the read SQL, but their internal transaction wrappers
must not create nested/independent transactions inside the view. Supply get-only
ports bound to the pinned view and enforce checkpoint digest equality there.
No migration, SQL application-job query, session implementation or transaction
manager is invented here because those belong to Track A.

## Exact status mapping

| Durable evidence | Projection |
| --- | --- |
| Application job status | Same allowed chat enum; never inferred from evaluator completion |
| Checkpoint missing / pending / ambiguous | Same detailed state; other/provider blocker; no completed phase milestone |
| Completed text design, status blocked | Detailed blocked and provider blocker, never delivered |
| Completed text design with verified frozen suite | Planning phase observed; suite hash/job/freshness checked |
| Completed text run | Running phase observed; actual `run_result.value = {environment, run}` parsed with `SuiteRunSchema` |
| Text check pass / fail / concern | passed / product_failure / rubric_concern in detailed outcomes |
| Text check inconclusive / not_assessed / error | Preserved exactly and provider blocker |
| Text infrastructure_error (even with pass checks) | infrastructure_error and provider blocker |
| Calendar passed / product_failure / inconclusive / infrastructure_error | Preserved exactly; last two add provider blocker |
| Completed text investigation with pending/refused/invalid investigator | blocked and provider blocker |
| Text investigation unresolved findings/test defects/reproductions | inconclusive/infrastructure blocker; never promoted to a pass |
| Calendar investigation pending reproduction IDs | blocked and provider blocker |
| Acquisition acquiring / waiting_for_data / waiting_for_expert | Exact state and saved phase in `project().acquisition`; input blocker in chat |
| Acquisition missing | missing with null phase; input blocker |
| Acquisition ready | Requires complete phase and current quality assessment equality; stale approval rejects |
| Delivered app status with missing/blocked/unresolved evidence | Refused as invalid_snapshot |

Run formats use actual `run_result` / `calendar_run` kinds; investigation formats
use `investigation` / `calendar_investigation`. Text run envelope environment,
job/run/suite associations, expected scenario inventory and timestamp ordering
must agree. Calendar result scopes use the actual `{jobId, runId, version}` shape;
branch binding comes from the enclosing run. Unknown result enums reject.
A persisted completed phase means that operation returned, not that the product
passed. Product failures and rubric concerns can appear in a delivered report.
A passing run alone leaves a running application job running.

`project()` retains exact finite labels without arbitrary prose. The existing
chat schema has generic milestone names and blocker categories, so its answers
show phase/category counts. Exact acquisition distinctions remain available to a
future authorized consumer through `project()`; no UI or chat-answer schema change
is included. Findings are intentionally not copied from raw investigation claims:
the chat snapshot has no imported findings and the existing answers explicitly
say this does not establish absence of problems. A future finding projector must
validate full original/reproduction associations before asserting confirmation.

## Privacy, costs and freshness

All evidence references and record IDs are HMAC-SHA256 over subject/job, record
kind and stable identity. Supply a stable server-only reference key of at least
32 UTF-8 bytes. Raw IDs, target URLs/keys, session IDs, descriptions, source/case
text, traces, arbitrary progress/error prose and connection strings never appear
in output. Reference-key rotation changes references and chat cursors; keep key
retention aligned with evidence/history retention. Resolve references through an
authorized lookup using the same key and scope; this module creates no public
lookup endpoint or mapping table.

Unselected raw content is stripped rather than echoed or hashed into public
content fingerprints. Known secrets (including short nonempty supplied strings)
and recognized credential patterns in final output cause refusal. The optional
known-secret supplier runs locally on every projection. It must perform no
external work. These checks supplement allowlist mapping; they are not universal
secret detection. The reference key itself is never output.

Only complete, authorized, measured existing `CostEntry` rows with session
identities become known `naive` costs. Duplicate sessions, foreign jobs,
unmeasured entries, unsafe amounts/totals and oversized schema arrays reject.
Session IDs/purpose/role metadata stay private. Keep unsupported Gateway costs,
customer-provider costs and incomplete ledgers explicitly unknown; do not silently
omit them and set `unknownCosts: false`. A future Gateway ledger mapper needs its
actual durable record contract. Unknown/final cost is never estimated as zero;
existing chat answers retain the distinction between persisted known totals,
unknown additional usage and a customer invoice.

Freshness is exactly `observedAt`, never request time. Future records relative to
the watermark reject; old watermarks remain visibly old. No wall-clock staleness
threshold or live activity is inferred. Acquisition milestone times use its
saved `updatedAt`. Checkpoints have **no timestamps** in the existing migration;
their milestone timestamp is the durable view's observation time, not an invented
completion time. Planning/running/investigating milestones therefore mean that
saved phase evidence was observed by that watermark. No percentage or ETA is
computed. Reordered inventories/ledgers produce stable sorted references.

## Exact server wiring

The application implements the three trusted boundaries below. This function is
ordinary server TypeScript and uses the existing private conversation port:

```ts
import { createProgressChatService } from './reporting/chat/service.js';
import type { ConversationPort, TrustedAccessPort } from './reporting/chat/types.js';
import {
  createDurableProgressProjection, createDurableProgressReader,
  type ConsistentProgressReadPort, type ProgressProjectionPorts,
} from './reporting/chat/projection/index.js';

export function chatForAuthenticatedRequest(deps: {
  access: TrustedAccessPort; // verified server session + application job policy
  resolve: ProgressProjectionPorts['resolve']; // authorized persisted inventory
  durableReads: ConsistentProgressReadPort; // consistent scoped get-only view
  conversations: ConversationPort; // e.g. existing PostgreSQL conversation port
  referenceKey: string; // server secret, never request JSON
  knownSecrets: () => readonly string[]; // current local policy
}) {
  const progress = createDurableProgressProjection({
    access: deps.access,
    resolve: deps.resolve,
    reader: createDurableProgressReader(deps.durableReads),
    referenceKey: deps.referenceKey,
    knownSecrets: deps.knownSecrets,
  });
  return createProgressChatService({
    access: deps.access, progress, conversations: deps.conversations,
    knownSecrets: deps.knownSecrets,
  });
}
// const chat = chatForAuthenticatedRequest(trustedServerDependencies);
// await chat.poll({jobId});
// await chat.send({jobId, messageId, question: 'Progress and costs?'});
```

The constructor accepts no browser identity. Authenticated route validation,
`Cache-Control: no-store`, owner/operator choices, retention, rate limiting,
production SQL consistency and evidence endpoints remain application work.

Pass the same current secret-policy supplier to both services. Chat screens
stored replay/history and atomic append winners as well as fresh replies; a
policy change refuses unsafe stored content without modifying its evidence.
Each supplied secret must contain at least four characters.

For calendar investigation inventory, `runId`, `branchId`, `suiteDigest` and
`scenarioIds` are required and describe the original run. Isolated per-scenario
run IDs differ from the enclosing run ID; reproduction/finding joins retain their
own exact scopes. Supply the expected design `suiteDigest` once available so
same-job suite substitution is rejected. Ready acquisition retrieval/review
timestamps cannot postdate the task update that saved the assessment.

## Verification

Run with the existing nested harness and locally available contracts:

```sh
node tests/track-b/run-checks.mjs --components reporting,evals \
  --track-a-ref be522f1e13e697017bac96728748b82cadc08ab9
```

Tests cover direct/chat authorization, user/job substitutions, returned scope and
input-digest conflicts, missing/duplicate checkpoints, old/future watermarks,
partial/mismatched runs, all text/calendar outcome mappings, acquisition waiting
states, infrastructure results, blocked saved investigations, delivered gating,
opaque/stable evidence, cost isolation/deduplication, raw secret stripping,
public-secret refusal, deterministic poll and get-only view composition.
Existing checkpoint/data/chat tests also exercise their actual SQL in PGlite.
New projection fixtures are local deterministic reader fakes; they do not prove
production authentication, database policies, consistent multi-session SQL reads,
managed failover or live customer behavior. No provider/target/cloud calls or
spend were performed. No native PostgreSQL verification is claimed for this adapter.

Final local verification: strict TypeScript and **386/386 tests in 28 files**
passed, none skipped, including **52 new projection tests** (30 mapping/composition
and 22 negative-boundary cases). Track A contracts were read from the pinned local
commit above; contract digest
`67a98dc7ddab55f56223fe40b402edae6bd0edbab4d4d070a19706fc006ae915`.
The checkout initially lacked harness dependencies. A temporary symlink to the
existing `/tmp/autonomous-evals-checks.m10du4/node_modules` cache was used and
removed afterward; no dependency install or manifest edit occurred. An initial
alternate cache lacked SDK/pg types; local TypeScript narrowing errors introduced
during implementation were corrected before the final run. Earlier intermediate
green counts were 375 and 383; the final 386 includes the additional blocked-design,
stale-ready-assessment and missing-acquisition tests. No full/all-component,
production route or native PostgreSQL check is claimed.
