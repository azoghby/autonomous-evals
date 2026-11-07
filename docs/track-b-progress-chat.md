# Track B private evaluation progress chat

Implemented only under `packages/core/src/reporting/chat/`; server-side Node service, no workflow/orchestrator, outbound notifications, target requests, agent sessions, or spend. Three independent implementation agents supplied schemas, deterministic answers, and durable file persistence/tests; parent integrated service and adversarial tests. ECC was not used.

Read-only integration baseline: local PLAN.md/TRACKS.md and origin/track-a at `802a46fbec4f5a920cc8b8f4ab952120f960cf2b` (contracts/index.ts, app messages/progress routes, server queries, application schema). Track A contracts, app, database and root configuration remain unchanged.

## Interfaces

Import `createProgressChatService` and ports from `packages/core/src/reporting/chat/index.ts` in server code. Construct the service per authenticated request, with trusted adapters:

- `access.authenticate()` resolves `{ subjectId }` from the verified server session. No browser identity is accepted.
- `access.resolveAuthorizedJob(caller, jobId)` returns `{ subjectId, jobId }` only after checking job access. Return null for missing and unauthorized jobs. The returned subject must be the caller, including for operators: private conversation history is never shared with another viewer of the same job.
- `progress.read(scope)` returns a complete validated customer-safe `ProgressSnapshot` from persisted records. It must recheck/retain authorized scope through the database query. Every snapshot is job-bound; timestamps, enums, record IDs, counts and costs are accepted, arbitrary prose fields are rejected.
- `conversations.get/append/list(scope, ...)` partitions by **both subjectId and jobId**. No operation may query by a message ID alone. Append must atomically implement first-write-wins and allocate increasing per-scope sequences. Races return the committed original exchange, including its original input digest.

Service methods accept unknown JSON and reject extra fields, including customer/subject identity:

```ts
await service.send({ jobId, messageId, question });
// => { messageId, inputDigest, sequence, reply }
await service.history({ jobId, afterSequence: 0, limit: 20 });
// => { messages, nextAfterSequence }
await service.poll({ jobId, cursor: previousCursor });
// => { cursor, changed, asOf, reply? }
```

Each method authenticates and authorizes again, even replay/history/unchanged polls. Questions are trimmed, bounded to 4,000 characters and 8,000 UTF-8 bytes, and hashed. Only the digest and answer are persisted: raw questions may contain credentials or prompt text and are deliberately not stored or echoed. UI can show the submitted question locally; after reload it can show persisted assistant replies. Reuse of the same scoped message ID and normalized question returns the original answer/freshness without reading current progress. Different input under that ID returns `conflict`; request a new message ID to get current progress.

History pages contain 1–50 entries in ascending sequence; `afterSequence` is exclusive. Polling is read-only and may use the plan's 3-second interval. Its opaque SHA-256 cursor binds caller/job and the complete snapshot; unauthorized users get no change information. Omit the cursor initially. The cursor is a change marker, never an access credential. Array ordering must be stable for stable cursors. Polling refreshes progress without creating conversation messages. Set route responses `Cache-Control: no-store`.

`ChatError.code` is one of `unauthenticated`, `not_found`, `invalid_input`, `conflict`, `invalid_snapshot`, `storage_error`, with fixed public messages. Suggested HTTP mapping: 401, 404, 400, 409, 503, 503 respectively. Do not send raw adapter exceptions, Zod issue input, or database errors to customers or logs.

## Persisted projection and honest answers

`ProgressSnapshotSchema` defines the full projection: job state and status evidence reference, persisted `observedAt`, milestones (200 max), findings (200 max, each with 1–20 evidence refs), blockers (50 max), costs (1,000 max), and `unknownCosts`. Every record has a stable opaque ID. Duplicate IDs, unsafe cost totals, wrong-job snapshots and milestones after projection freshness fail closed. The projection must be complete within these bounds; do not silently truncate a ledger and present it as a complete cost total. If a job exceeds the bounds, return unavailable until an agreed aggregate contract exists.

Use `observedAt` as the persisted projection's consistency watermark, not the HTTP response time. Build a consistent database read and watermark covering status, milestones, findings, blockers and costs. Answers return `asOf`, evidence references, explicit unknowns, and deterministic text for progress/ETA, costs, findings, blockers and combined summaries. Unsupported questions get a usable capability response plus recorded status. No estimated finish time, percent complete, invented transitions, raw evidence excerpts, prompts, provider bodies, invoice totals or inferred absence of problems. Costs are known persisted evaluation costs, with unrecorded/final costs explicitly unassessed. Empty findings/blockers do not establish a clean or unblocked run.

The adapter is a security boundary: map only verified customer-visible IDs into evidence references; never put URLs, credentials, prompts, session tokens or raw text in ID fields. Syntactic token validation is not secret detection. Map finding evidence to authorized opaque evidence record IDs (existing Track A Evidence contains excerpts/location, not durable reference IDs). Do not pass findings' descriptions, cost meta/session IDs, arbitrary progress messages or job.error into this projection. Classify milestones/blockers into the allowed enums; preserve original records in the existing system of record. UI must resolve references through its authorized evidence routes and render reply text as text. No model is required; any future optional agent integration needs the existing reservation/session budget service and separate grounding validation.

## Track A wiring still required

The existing POST `/api/jobs/[jobId]/messages` is clarification-only and can resume Workflow. Keep it separate from this read-only progress Q&A; add dedicated chat POST/history GET/poll routes and UI available while running (and after delivery). Bind access to `getCurrentCustomer` and an owner authorization check. `getJobForViewer` currently grants operator views too; consciously choose operator access, always retaining caller-private conversations. Never derive subject from request JSON or job owner fields alone.

Track A owns a Neon conversation schema/adapter with `UNIQUE(subject_id, job_id, message_id)`, `UNIQUE(subject_id, job_id, sequence)` and atomic append allocation/replay. Store normalized-input digest and validated reply JSON with freshness/evidence refs. Use a transaction and per-scope lock/sequence allocator; rollback/race retries must return the original row. Add foreign keys, access policy, retention and production route/auth tests under Track A ownership. Existing `messages` rows are job-scoped and lack private-user partitioning/idempotency; do not reuse them unchanged. Track A must implement persisted blocker projection and stable evidence IDs and expose known costs to the authorized chat projection (current customer job query omits costs).

`createFileConversationPort(directory)` is an included durable adapter for a **trusted persistent single-host filesystem**, not Vercel ephemeral storage. It hashes scope into path partitions, validates stored scope/sequences, bounds disk reads at 16 MiB and conversations at 1,000 exchanges, atomically renames/fsyncs writes, and locks appends across adapter instances/processes. When full it fails closed without deleting replay keys. A crash can leave `append.lock`; stop all writers and recover it operationally, never steal it while a writer may remain active. Protect/backup the root directory; local filesystem administrators are trusted. Provision fresh private directory permissions. No dependency or application migration changes are needed to exercise this adapter locally.

## Verification

Run the existing strict nested harness (dependencies installed from its existing lockfile):

```sh
npm ci --prefix tests/track-b --ignore-scripts --no-audit --no-fund
node tests/track-b/run-checks.mjs --components reporting --track-a-ref origin/track-a
```

The harness stages nested chat tests automatically; no harness support-directory change is necessary. It performs strict TypeScript checks and asserts every staged test executed, with no skips/todos. Tests cover private user/job history, unauthorized replay/poll/history, forged identity rejection, malformed and secret-bearing inputs, wrong-job/malformed snapshots, each lifecycle state, duplicate ledger rows, inconsistent freshness, unsafe totals, exact costs, evidence/unknowns, stable/conflicting/concurrent replay, bounded history, cursor updates, restart durability, concurrent adapters, path injection, corrupted/cross-tenant persisted state and fixed infrastructure error messages. No live provider/cloud calls or spend were used. Production Neon persistence and route/UI wiring remain Track A integration work.
