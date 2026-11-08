# Durable Workflow stage ownership: next implementation contract

Latest continuation: `naive-stage-recovery-integration` adds strict real qualification/audit/report recovery, lease renewal and terminal-child completion proof in staged source. Mixed callback coverage and hosted acceptance remain incomplete. Read that artifact's final receipt before interpreting the older ownership-only note below.

Current implementation note (2026-11-08): `naive-stage-ownership-integration` implements a bounded, unapplied portion of this design. Read its README/validation receipt: current callbacks do not opt into takeover because complete child coverage and lease renewal remain missing. The requirements below remain the full design, not a deployment claim.

Status: **design, not implemented**. Repository checkpoint `1cf90a5`; follows the shared-budget candidate. It addresses that candidate's remaining `(job, agent)` open-hold reuse gap. A reservation is not exclusive permission to execute a callback.

## Verified installed APIs and existing identities

Inside an executing step, `getWorkflowMetadata().workflowRunId` and `getStepMetadata().stepId` identify the Workflow invocation. `getStepMetadata().attempt` increases on retries. Evidence: `node_modules/@workflow/core/dist/step/get-step-metadata.d.ts`, `step/get-workflow-metadata.d.ts` and its implementation; the installed `workflow/docs/api-reference/workflow/get-step-metadata.mdx` shows using `stepId` for external idempotency. Helpers invoked within a step share this context; do not turn `withBudget` into another step merely to obtain metadata.

Keep two distinct durable identities:

| Identity | Purpose | Retry rule |
|---|---|---|
| Job + Workflow run + step ID | Which invocation owns execution | SDK attempt records evidence; it does not create a new payable operation |
| Canonical logical stage + immutable input digest | Which business operation and budget envelope are being resumed | Stable across SDK retries and explicit pending/polling steps |

The second identity is essential: actual `expertTextEvaluationStep` returns `pending` normally and has `maxRetries=0`; a later poll can have a different step ID while referring to the same retained expert task. Qualification needs its revision/request digest, suite execution its frozen suite/target slot/version, and remediation its finding/trial identity. Agent name alone cannot distinguish these stages.

Existing generic agent task identity is defined by `taskKeyFor` in `packages/core/src/agents/session-service.ts`: job, role, purpose and deliberate agent attempt. Do **not** assign Workflow retry `attempt` to that field. The runner already handles uncertain creates using the retained task/body/key. Expert data similarly retains `taskId` and `requestHash`; preserve those identities across Workflow polling.

## Required state and transitions

Add an immutable logical-stage row containing canonical job/owner/environment, logical operation, input digest, role, envelope/reservation ID, and a private result reference. Maintain execution ownership separately: invocation identity, random owner token, generation, state and retry evidence. Claim under the canonical job budget lock. A duplicate invocation that lacks ownership must not enter the callback.

Before each child dispatch, associate its exact existing operation/task/attempt identity with the stage and check the current generation. Retain dispatch intent before crossing the provider boundary. Stale owners must fail both dispatch and publication checks; checking only callback entry/exit or a heartbeat is insufficient. Keep role/job budgets and current authorization checks intact.

On successful completion, persist the validated result/reference and release the appropriate envelope in the same transaction. A lost Workflow acknowledgement replays that retained result under current owner authorization. A normal `pending` outcome is not successful completion: retain the stage, hold and child identity for recovery by a later invocation.

Lease expiry means **reconciliation required**, never proof that the provider did not receive a request. Recovery must classify retained children:

- Proven undispatched: safely transfer execution ownership without changing the logical operation or granting extra budget.
- Dispatched/pending or accepted-create/lost-response: resume the existing provider recovery protocol, body and idempotency identity; preserve unknown spend.
- Completed and validated: replay the retained result and finish publication/settlement without a new provider call.
- Unverifiable: remain held with a specific reconciliation state. Do not permanently collapse all pending states into a generic failure, and do not manufacture evidence to unblock them.

Gateway paths lacking durable child dispatch/result identity cannot safely restart solely because a stage lease expired. The job-chat turn reservation is only one such path; inventory ordinary lite evaluation calls too. The wrapper alone cannot establish safe automatic retry for uninstrumented children.

## Implementation ownership and acceptance

Split implementation into three disjoint workers: SQL stage authority/claims/recovery; Workflow callsites and typed pending propagation; child-operation association/fencing at current server composition seams. The integrator owns candidate assembly and verification. Do not change Track B runner directories under the current instructions; if a necessary hook is missing, prepare its exact owner patch rather than pretending a wrapper provides it.

Required evidence includes concurrent duplicate delivery, unrelated same-agent stages, overlapping SDK retries, stale callbacks after takeover, crash before dispatch, accepted create with lost response, provider pending then terminal, completed callback with lost Workflow acknowledgement, expert polling across different step IDs, changed-input rejection, and explicit parent/child budget coverage. Use native PostgreSQL connections for lock/takeover acceptance; PGlite can test state transitions but does not establish concurrent behavior. Rebase this work with factual/sourcing candidates before joint adoption.

This document does not close the full Naïve plan or any deployment gate. Current stage ownership remains unfinished until these transitions are connected and verified.
