# Private progress chat integration review

Reviewed Track A `07cf5dfe811de25ce31c4ed1ac05cb3b4a1f5b4f` and chat backend `ce4d2830ad467816d1ed4ed16c3366b5a2b67633` using `git show`. No Track A source was changed. This review defines a required handler contract; it does not claim those handlers exist.

## Authentication and isolation

`apps/web/src/server/session.ts:getCurrentCustomer()` verifies the `ae_session` cookie and returns the authenticated customer `id`. Bind backend `TrustedAccessPort.authenticate()` to `{ subjectId: me.id }` per request. Never accept subject/customer IDs, session IDs, email, or an `asCustomer` flag from browser input. Do not use the job owner's ID as the caller identity.

`apps/web/src/server/queries.ts:getJobForViewer()` uses `canViewJob` and permits both owner and operator access. The recommended initial chat rule is **owner only**: check `job.customerId === me.id` using a minimal authorized lookup. Missing and unauthorized jobs both return 404. If Track A deliberately supports operators, each operator retains their own `subjectId`; operators must never inherit the customer's conversation partition. Reauthorize every history page, send/replay, and poll, including unchanged cursors.

Existing `schema.messages` rows have only job ID/role/body/time and are not private per viewer. Existing POST `apps/web/src/app/api/jobs/[jobId]/messages/route.ts` accepts clarification answers and calls `sendJobEvent`; do not call or extend it for read-only progress Q&A.

## Required trusted server adapters (production blockers)

1. **Durable private conversations:** Track A has no conversation table with subject scope, input digest or sequence. Add foreign keys and unique constraints on `(subject_id, job_id, message_id)` and `(subject_id, job_id, sequence)`, plus transactional per-scope sequence allocation. Concurrent replay returns the first committed exchange unchanged; differing input under the same ID returns conflict. Scope every read/write by both subject and job. Apply retention/access policy. The backend filesystem adapter is unsuitable for ephemeral Vercel storage.
2. **Complete safe persisted projection:** `getJobForViewer()` reads multiple records concurrently, omits costs and does not provide a consistent projection watermark. Implement an authorized consistent snapshot of status, milestones, findings, blockers and known costs with a persisted `observedAt`. Do not substitute response time. Enforce backend bounds; do not silently truncate costs, findings or blockers. Preserve explicit unknown-cost semantics.
3. **Opaque evidence references:** `contracts/index.ts:Evidence` contains excerpts and optional location, with no stable opaque evidence ID. Establish durable authorized IDs and an access-checked resolver before passing references. Do not emit fabricated URLs, excerpt text, provider bodies, tokens, cost metadata/session IDs or `job.error`. The current UI can display references as text without inventing links.
4. **Blocker and waiting projection:** `progressEvents.milestone`/`message` are arbitrary prose; no typed persisted blocker projection exists. The backend snapshot's blocker kinds are only `budget | payment | input | provider | other`; its reply has no structured waiting state. `expertRequests` has `open | answered | closed`; `expertEngagements` has `invited | answered | paid | cancelled`, mode `async | call`, but none is exposed in the safe customer projection. An open request or invited engagement alone does not establish that job execution is blocked. Track A must establish the authoritative semantics for asynchronous data acquisition and expert waiting. Until then, show explicit unknown/unavailable status; do not infer waiting from `investigating` or parse free-text milestones.

These blockers prevent a responsible production route patch. The UI injection seam is the reviewable integration deliverable; no live endpoint is implied.

## Handler contract to implement after adapters exist

Use dedicated same-origin job-chat handlers, with actual route names chosen and wired by Track A. The browser transport must bind these methods to them explicitly; it must not silently call a guessed URL.

| Operation | Trusted service call | Browser-visible result |
| --- | --- | --- |
| Send | `service.send({ jobId: pathJobId, messageId, question })` | `{ messageId, inputDigest, sequence, reply }` |
| History | `service.history({ jobId: pathJobId, afterSequence, limit })` | `{ messages, nextAfterSequence }` |
| Poll | `service.poll({ jobId: pathJobId, cursor? })` | `{ cursor, changed, asOf, reply? }` |

Construct `createProgressChatService({ access, progress, conversations })` from server-owned ports on every request. Import through `@ae/core/reporting/chat/index` only after the backend is integrated and package exports resolve; never bundle service/Node crypto/file adapters into the client.

Use strict input validation. Path job ID is authoritative; reject additional identity fields or conflicting body job ID. Bound request bodies before reading, require JSON for mutation requests, enforce same-origin Origin/Fetch Metadata checks and the application's CSRF policy, and rate-limit per verified caller/job. Send has no execution, spending, notification, or workflow side effects. History and poll are read-only. Use same-origin credentials and AbortSignal in the client adapter.

Every success and failure response needs `Cache-Control: no-store`; bypass shared caches and do not persist browser chat data in localStorage/sessionStorage. Use fixed error codes/messages and status mapping: `unauthenticated → 401`, `not_found → 404`, `invalid_input → 400`, `conflict → 409`, `invalid_snapshot | storage_error → 503`. Never echo adapter exceptions or input values. Client transport should translate errors to a typed public error with status/code. Clear private UI state on 401/404 and on job/auth-scope change; an auth-scope key must change when the verified customer changes. The server remains the access boundary.

Questions are trimmed and bounded to 4,000 characters and 8,000 UTF-8 bytes. Persisted history contains replies and input digests, not raw questions. Display questions from in-memory submissions only; after reload label saved replies honestly. For ambiguous network failure, retry the identical question under the same message ID. A new question requires a new ID. Poll cursors are change markers, never authorization tokens; do not insert poll replies into persisted conversation history.

## Required production acceptance checks

Exercise no session, expired session, other owner, operator policy, forged subject input, same-job/different-caller isolation, cross-job message replay, unauthorized unchanged poll, and authorization loss during requests. Verify atomic replay/conflict and concurrent sequence allocation in the production adapter. Confirm safe projection against secret-bearing evidence/meta, inconsistent freshness, bounds, duplicate IDs, unknown costs and complete ledgers. Confirm send cannot trigger workflow/spend/outreach. Verify no-store on errors as well as successes and cross-origin mutation rejection. This review did not execute those production checks because the adapters/routes do not exist at the reviewed baseline.
