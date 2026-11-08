# Proposed deterministic expert scope authorization bridge

Status: **implemented as an unapplied integration candidate** in [naive-sourcing-authority-integration](naive-sourcing-authority-integration/README.md), layered after the 39-file factual Workflow candidate. Combined verification passes 4,128 tests, web/core types and a production build; no source adoption or live activation is claimed. This document does not grant authority, record consent, approve a contact, apply migrations or authorize live provider use. Actual adoption of the 39-file owner candidate requires explicit owner approval; continuing a goal is not that approval.

## Baseline and evidence

The combined candidate is `docs/naive-factual-workflow-integration`, whose manifest pins base `7118f3af0d472b3a453aa9b5443e6f63b5b0df59` and describes an unapplied owner candidate. Its README explicitly leaves automatic exact-scope authorization open. These recommendations require rebasing/reverifying that candidate against the adoption checkout; its historical verification receipts do not certify future composition.

Relevant source paths:

- `packages/core/src/db/schema.ts`: `expertAutomationPolicies`, `expertAutomationScopes`, `expertAutomationQualifications`, operations and invitations.
- `apps/web/src/server/automated-expert-owner.ts`: exact scope authority, opt-in classification, qualifications, promise caps, founder approval and actual send path.
- Candidate `postimages/apps/web/src/server/expert-data-plan.ts`: canonical input/credential locking, `deriveFactualGapPlan`, exact scope lookup and plan insertion.
- Candidate `postimages/apps/web/src/server/naive-text-execution-selection.ts`: insert-once new-job enrollment and retained execution selection.
- `packages/core/src/contracts/index.ts`: `authorizedToTest` is test authorization, not expert sharing consent.
- `apps/web/src/app/api/experts/signup/route.ts`: expert signup consent belongs to the expert, not the tenant.

## Authority boundary

The owner authorizes a versioned deterministic derivation rule for a bounded job/topic envelope. The model proposes coverage only. Trusted code validates that proposal, binds it to the retained canonical job and target, and derives the exact downstream request hash. Future hashes need no manual preconfiguration, but every derived hash needs an auditable authority chain.

Opted-in qualified experts may be contacted automatically under existing gates. New cold contacts still require founder approval of the exact invitation. Neither sourcing authorization nor tenant consent grants cold-contact approval, factual-evidence approval, payment authority beyond existing reservations, or increased caps. Preserve $25 per job and $50 per day, including existing shared-ledger accounting.

## Proposed durable contracts

Names below are proposed. Use additive migrations, foreign keys, bounded fields and explicit constraints; do not recycle an unrelated consent column.

### Standing owner sourcing policy

`expert_sourcing_policies`: immutable versioned owner authorization for one tenant/environment and one owner-selected topic, linked to the existing cap policy. Bound permitted packages/profile/derivation version, evaluation use, sharing-envelope version, maximum questions/context size, accepted check categories, policy lifetime and default job-authority lifetime. Record authenticated operator issuance and revocation. Enforce unique active policy identity for tenant/environment/topic; conflicting matches fail closed. No wildcard customer access, arbitrary executable predicate, model-assigned topic or implicit consent.

The owner configures this standing envelope once. Eligible new jobs can then derive their job authorization automatically under that envelope, without an operator approving each job or future proposal hash. Topic comes from an explicit customer selection among configured eligible topics, or the sole configured topic; a model classification alone cannot select authority. If selection is ambiguous, ask the customer to clarify. Testing/sharing consent remains an explicit authenticated input. A once-only setup prerequisite is different from mandatory manual approval on every evaluation.

### Owner sourcing authorization

`expert_scope_authorizations`: UUID id; tenant_id/customer FK; job_id/job FK; environment (`test` or `live`); existing policy_id FK; topic (trimmed, 1–160 characters); derivation_version fixed to `factual_gap_exact_scope.v1`; execution_profile fixed to the factual profile; expert_task_id matching the existing bounded task syntax; required_uses fixed to `["evaluation"]`; sharing_envelope_version; canonical_input_digest and target_digest (64 lowercase hex); issued_by_operator; issued_at; expires_at; revoked_at/revoked_by/reason.

Each execution authorization is job-specific and links to the exact standing policy ID/version/digest that issued it. Trusted code materializes it automatically when the job matches that configured envelope and has authenticated consent. Record `issued_via=standing_policy` and the deterministic policy principal; never fabricate an operator session for the derived grant. Topic matching is exact against qualified expertise. Multiple jobs may reuse an enabled standing/cap policy, but not each other's authorization. Bind the derived grant to canonical input and credential-sensitive target digest; changed inputs require deterministic reauthorization under the still-current standing policy, with a new immutable grant rather than mutation of the old one.

Constraints: composite ownership reference or equivalent validated job/tenant identity; immutable issuance fields; expiry after issue; revocation metadata consistency; one active issuance per job/task enforced by the serialized writer (a partial unique index on unrevoked rows may additionally prevent overlapping grants, with explicit replacement/revocation). Never update an issued envelope in place. Retain the standing policy's authenticated operator issuer and the derived grant's policy principal, never a request-supplied issuer. Explicit one-off operator grants may use the same bounded contract but are not required for normal automated operation.

### Customer sharing consent

`expert_sharing_consents`: UUID id; tenant_id; job_id; authenticated_customer_id; consent_version; disclosure_text_digest; sharing_envelope_version; canonical_input_digest; issued_at; expires_at; revoked_at; revocation actor/reason. Immutable issuance fields and valid timestamp constraints as above. Retain the versioned disclosure text in source or a durable immutable disclosure catalog; a digest alone cannot explain consent later.

The disclosure must identify paid domain experts as recipients, evaluation as purpose, and the exact categories shared: bounded system-prompt context and proposed factual questions/rubrics. Credentials, raw traces, unrelated customer records and arbitrary external attachments are excluded. If current outgoing payloads exceed this envelope, block; changing the disclosure cannot retroactively expand existing consent. No backfill of positive consent from testing authorization, expert signup, owner approval, empty receipts or conversational assumptions.

### Exact derivation receipt

`expert_scope_derivations`: job_id/task_id primary key and FK to exact scope; authorization_id and consent_id FKs; tenant_id; derivation_version; proposal_digest; canonical_input_digest; target_digest; request_hash; topic; derived_at. All digests are validated lowercase SHA-256 strings. Make issuance append-only through application writers; exact replay reads and compares every field. A conflicting receipt or existing scope fails closed. The scope's copied sharing boolean is compatibility data, never sufficient runtime authority.

Existing scopes without a derivation receipt must retain their explicitly configured legacy behavior only through an explicit discriminator; never silently treat them as newly derived grants. New factual-profile scopes must require receipts. Do not convert an old scope into a derived scope by attaching arbitrary authority later.

## Authenticated input and lifecycle

Add an explicit, unchecked-by-default sharing-consent input to the signed-in job flow and the equivalent authenticated API/MCP intake contract. The server chooses disclosure version and principal from the session/token and writes the receipt atomically with job creation and execution enrollment. A client boolean alone is not a receipt. Reject foreign tenant/job identifiers, unknown versions, ambiguous coercions and attempts to set issuer/receipt ids. Existing jobs require a separate authenticated owner-consent action with current disclosure and canonical input binding.

Expose authenticated customer revocation for their own job and an operator-only authorization issue/revoke surface. Operator issuance validates current operator status, tenant/job identity, input and target binding, owner-selected topic, exact permitted envelope and enabled cap policy. Authentication, same-origin protection where applicable and bounded request parsing apply. Reads must not expose credentials or unneeded proposal content. No frontend design is specified here; actual UI work must first follow DESIGN_STANDARDS.md.

Revocation is durable and monotonic. Retry never re-enables it. Re-consent or replacement authorization creates a new record and requires an explicit policy for a new operation; existing immutable scope/operation identities are not rewritten. Stop future acquisition, promises and sends. Already delivered messages cannot be recalled, and already incurred obligations retain accounting/reconciliation records.

## Derivation algorithm

1. Resolve the retained factual execution profile and durable proposal; do not accept an arbitrary caller-selected proposal in place of the retained checkpoint. Compare checkpoint state/body digest, proposal digest, selected task/version and canonical job/tenant/environment.
2. Reuse the installer's canonical intake parsing, credential handling, deadline, real-mode and safety checks. Recompute credential-sensitive target binding. `deriveFactualGapPlan` validates factual-only requirements and produces the task; no model output selects authority fields.
3. Load and validate the uniquely applicable standing owner policy and explicit customer consent. Materialize the exact job authorization automatically under that policy, or validate its retained issuance. Check expiry/revocation, exact job/tenant/environment/task/profile/topic/envelope/input/target bindings, enabled fixed-cap policy and allowed uses. Compare shared content against the versioned envelope. No per-job operator action is required for an eligible job; absent standing authority cannot be inferred.
4. Compute `request_hash = reviewDigest({ task: derivedInput.task, topic: authorization.topic })` using the existing canonical digest helper, not ad hoc JSON hashing. Store the immutable proposal/input/target bindings in the derivation receipt.
5. Insert any derived job authorization, exact scope and derivation receipt and install the plan in one transaction. Existing rows replay only after full equality validation; mismatch, disabled scope or revoked plan fails closed. Missing qualification, consent or authority remains a typed prerequisite block, not an invitation to synthesize records.
6. Existing acquisition gates select qualified active unsuppressed experts and apply opt-in versus founder approval. Independent contribution review remains required before data enters factual evaluation.

## Locking and actual send-time revocation

Canonical row order must remain compatible with the installer: job `FOR UPDATE`, job credential row, retained selection/proposal checkpoints in stable kind/id order, standing policy, derived job authorization, consent, exact scope, cap policy, derivation receipt/plan, then operation/contact/qualification/invitation/draft/engagement and budget rows in stable ids. Refactor cooperating runtime and authority writers to this order; do not add a reverse policy→job or invitation→job path. Coordinate budget-wide locks consistently with the existing reservation protocol, and prove it with multi-connection tests.

There is a material existing boundary: `automated-expert-owner.ts` claims an invitation, rechecks authority in another completed transaction, then calls `sendEmail`. Revocation can currently race between that recheck and dispatch. Adding joins to `authority()` alone does not close that gap.

Introduce a common standing-policy dispatch/authority mutex followed by a per-job mutex, both acquired **before** row transactions by derived-scope issuance and actual dispatch paths. Standing-policy revocation takes the same policy mutex before committing revocation, so one tenant policy cannot be revoked between a sender’s last check and dispatch. A first implementation may serialize sends within that policy using an exclusive advisory lock; shared-send/exclusive-revoke locking needs its own verified adapter. Customer job-consent revocation takes the job mutex and must not acquire the policy mutex afterward; it updates only the job-bound consent/revocation rows. Any path needing both takes policy first, then job; after acquiring locks, revalidate that the selected policy is still the canonical one. Prefer a dedicated connection session advisory lock using the project's checked session-lock mechanism, released in `finally`; loss of lock connection before dispatch must abort. After claiming, retain/reacquire these mutexes in the documented order, revalidate the live authorization, tenant consent, scope receipt, policy, canonical binding, expert consent/suppression/qualification, exact draft and founder approval where needed, and only then call the provider while still holding the mutexes. Record completion before release. Avoid leaving a database row transaction open during network I/O.

This establishes a precise ordering: if revocation commits first, no later send starts; if dispatch already holds the mutex and begins first, revocation waits and cannot undo that send. Document that boundary in the revocation response. No claim of instantaneous cancellation of an in-flight provider call. A claimed-but-unsent invitation must pass the same live gate on any retry; ambiguous provider outcomes remain ambiguous, never blindly resent. Inventory all send paths, including approved-draft resend and founder approval handlers, so none bypasses the mutex/gate for managed invitations. Other policy/suppression writers that promise equivalent revocation behavior must coordinate with this mutex too.

## Required verification matrix

| Area | Required positive and negative cases |
| --- | --- |
| Issuance | Correct operator grants envelope; anonymous/nonoperator/forged issuer/foreign job/environment mismatch rejected; topic supplied by proposal ignored/rejected; no wildcard authority. |
| Standing policy | One-time configured envelope permits multiple eligible jobs without per-job operator action; cross-tenant/topic/environment, expired/revoked policy, ambiguous matches, model-supplied topic, oversized/disallowed sharing categories and changed policy versions block; no consent is inferred. |
| Consent | Explicit authenticated issuance; absent/false/unknown disclosure/version/foreign tenant rejected; testing authorization and expert signup never count; old jobs not auto-consented; expiry/revocation enforced. |
| Binding | Retained proposal required; digest/body/checkpoint state mismatch, duplicate checks, unsupported coverage, wrong profile/task/version, changed intake/target/credential rotation or deletion fail before writes/side effects. |
| Envelope | Allowed context/questions pass; forbidden categories, credential leakage, unexpected attachments and expanded disclosure scope block. |
| Derivation | Exact deterministic scope hash, provenance linkage and atomic plan insertion; exact retry replays; conflicting existing scope/receipt/proposal rejects; disabled scope/plan never resurrects. |
| Expert policy | Qualified active opted-in contact automatic; cold contact pending until exact founder approval; inactive/suppressed/revoked opt-in/disallowed uses/missing qualification receipt blocked; evidence review still required. |
| Money | Existing $25/job and $50/day caps unchanged; parallel promises share limits; no duplicate reservation or promise on replay; revocation preserves incurred obligation accounting. |
| Runtime | Revoke standing policy/job authorization/consent after install, after promise, after claim and before dispatch; each next side effect blocks; copied scope boolean cannot bypass live receipt. Approved-draft resend cannot bypass managed gates. |
| Dispatch ordering | Two real PostgreSQL connections: revocation wins mutex and commits → zero provider calls; sender wins → revocation waits, one dispatch precedes revoke; blocked sender rechecks after revoke. Never claim cancellation of already started send. |
| Concurrency | Concurrent identical installers produce one scope/receipt/plan; different proposals one winner and conflict; issue/revoke/install races cannot revive grants; credential rotation and job cancellation race safely under canonical locks; stable lock order has no deadlock across installer/promise/send/revoke. |
| Failure recovery | Rollback after scope/receipt insertion leaves no partial grant; provider timeout stays ambiguous; crash after claim needs reauthorization; lock connection loss before dispatch blocks; failure to release session lock destroys connection; retry never duplicates a send. |

Use isolated databases and a fake provider for behavioral tests. PGlite may cover deterministic SQL behavior, but actual contention/lock ordering needs PostgreSQL multi-connection tests. Required integration checks remain web TypeScript, npm tests and composed build; hosted restart/provider acceptance needs separately authorized evidence. This proposal contains no claim those checks have run.

## Implementation and adoption slice

Disjoint work can cover (1) additive schema/repository/migration and SQL tests, (2) bridge/installer/runtime/managed send integration and concurrency tests, and (3) authenticated consent contracts/customer/operator input seams and API tests. The integrator owns composition, preservation of unrelated app changes, ledger updates, required checks and commit under the active owner instructions. Read applicable UI standards before any visual implementation. Coordinate shared-file ownership explicitly rather than allowing multiple workers to edit schema, intake or installer files simultaneously.

Before adopting: explicit owner approval of actual app39 source adoption; refresh candidate preimages/baseline; review this new authority and disclosure contract; implement the complete issuance-to-send chain rather than only scope insertion; verify additive migration and rollback/failure behavior; run required checks. Migration application, credentials, real provider calls, production enabling and deployment remain separate authorized actions. No secret values belong in artifacts or receipts.
