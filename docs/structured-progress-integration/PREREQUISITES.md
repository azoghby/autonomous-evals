# Required owner work and evidence boundaries

Track A source pin: `2dff9d8af8cccdd171d78760a0d74136d138fcb4` (local `origin/track-a`, inspected without fetch). Prior Trace chat artifact base: `96cb4adcea8c55ae4d8cc353deb059996245aa77`. The prior `docs/progress-chat-integration/combined.patch` must apply first; the current Track A pin does not contain its route or server adapter.

## Core availability and parent fixes

The structured core source used for offline verification is the immutable local commit `de6a7985e72b57fce79ef7f69f533b0b2da126a7`. It supplies `createDurableProgressProjection`, `createDurableProgressReader`, Text/Calendar checkpoint formats, acquisition storage and private conversation implementation. These modules do not exist at the Track A pin. Track A must integrate the compatible Track B core changes before applying the application adapter. The validation archive's explicitly pinned source overlay is a test prerequisite, not a production merge strategy or a claim that Track A already has these modules.

The parent fixed omitted finding projection and contradictory report-basis conversion in the pinned core. Parent validation reapplies the app patches with this core and positively checks persisted confirmed Text/Calendar finding visibility through SQL. Nonempty Text investigations require matching baseline run inventory, suite/scenario associations and their actual run ID as the investigation key ID. These core repairs do not supply the missing Workflow producers described below.

## Workflow prerequisites at the exact Track A pin

`packages/core/src/integration/compose.ts` binds legacy `designSuite`, `runSuite` and `investigate` to unavailable operations. `apps/web/src/workflows/steps/evaluate.ts` calls those legacy signatures and saves a contract Suite/blob and progress prose. It does not call the richer durable Text/Calendar factories or persist their expected checkpoint inventory. Neither the contract Suite nor progress prose contains authoritative checkpoint input digests. No historical backfill from these payloads is authorized by this artifact.

The owner must bind the real factories (`evals/integration` and `evals/calendar-integration`) to authorized job/customer/environment, reviewed frozen suite, stable target version and isolated branch. Persist the complete expected operation identities before dispatch where independently known, including missing/pending work, with their exact digest formulas from the factory's inputs. Calendar engine run IDs are generated during dispatch: its actual completed-run association cannot exist beforehand. The owner must add a durable planned-operation/claim association and final returned-result binding (or extend the inventory format explicitly) to cover that interval; this artifact does not supply that missing producer contract. Never use placeholder run IDs. Stable IDs must survive Workflow retry/restart; never create a replacement ID to evade a pending or ambiguous claim. A completed core operation must save its actual generated run ID and suite/branch/scenario associations alongside inventory finalization; a lost acknowledgement must reconcile with the original durable checkpoint rather than redispatch.

Acquire/review evaluation data through the existing tenant/job-scoped task store and admission gates. Register expected task IDs before acquisition starts, so waiting_for_data, waiting_for_expert and missing tasks remain blockers. Human review, provider/session reconciliation, measured cost delivery and frozen-suite admission are separate authorized services; chat must not invoke them.

## Storage and release checks

Apply SQL artifacts only through the owner's normal migration process; no request-time DDL. Required existing tables include core conversations, `text_integration.checkpoints` and `evaluation_data_persistence.tasks`, plus the new private inventory migration. Give only the server role access. Use the same authorized application database for inventory and checkpoints; simulator branch storage is separate. Keep job IDs globally unique and retain tenant/environment on every scoped join.

A durable observation watermark must cover the inventory and every included checkpoint, acquisition task, job state and measured cost. Updating only a request clock cannot establish progress freshness. The owner must commit observation after those writes, keep the revision immutable during a read, and use a pinned read-only REPEATABLE READ connection for projection. Authorization is rechecked in that snapshot; private conversation writes use their own existing transaction boundary. This does not establish instantaneous revocation across independent transactions.

Existing app cost rows lack the full `CostEntry` session contract and a completeness marker. Unsupported provider/Gateway usage and the final invoice remain unknown. Do not synthesize sessions or assert zero cost. Credentials and current known secrets remain server-only; retain current-policy screening on fresh output and saved history/replay.

The engine's frozen Text suite remains literally twelve scenarios, S01–S12. Track A's contract admits up to 32 and its Workflow appends an rt_* pack. These are different execution scopes. This artifact supplies no appended-pack execution/investigation/remediation evidence; that coverage is unknown until a separately reviewed durable contract exists. Never silently drop appended work while claiming full job completion.

No rendered/live app acceptance, full Next build, real Neon transport, multi-session PostgreSQL isolation, deployed session/RLS verification, real data acquisition, provider cost completeness, cloud migration or deployment is established by offline archive tests.
