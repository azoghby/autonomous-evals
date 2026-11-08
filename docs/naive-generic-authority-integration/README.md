# Generic text authority candidate

> Development slice only. The current combined adoption candidate is [naive-generic-text-adoption-integration](../naive-generic-text-adoption-integration/README.md). That artifact includes later integration fixes and portable package imports; do not apply this partial slice independently or treat its earlier validation as current application acceptance.

Owner slice 1 only. Copy the two exact source files under `source/` to their matching repository paths when adopted. Existing text_integration checkpoint migration is required; no new schema is introduced. Track A/B source and migration journal are unchanged by this candidate.

`createNaiveMethodAuthority(ctx, deps)` accepts SQL, a trusted independent `admissionPolicy`, current `authorizeApproval`, and optional credential decryption for tests. It returns design authorization, durable admission/run/investigation artifacts, checkpoints, current dispatch/publication authorization, and exact retained-suite resolution. Design/run IDs are canonical deterministic slots. Raw keys remain memory-only; full intake and credential-bearing target digests fence substitution across restart. Current owner, environment, state, credential deletion/deadline and retained approval are checked before dispatch and publication.

Neither callbacks nor an approved model review alone constitute human approval. A production policy must authenticate independently reviewed exact design receipts and its own current revocation authority. There is deliberately no permissive default. The generic binding cannot reuse expert grants. Existing rich artifact ports retain complete immutable run/investigation bodies and reject conflicting replay.

Tests use PGlite and the actual checkpoint migration/artifact adapters, including reopen, pending/rejection, lost acknowledgement replay, public suite alteration, owner/environment/credential/input changes and revocation. Integration must wrap every target/judge/agent dispatch with `current()` and check after dispatch before publishing; measured cost retention remains separate from publication authority.

Validation: six focused SQL tests pass on root Vitest 5.1.0; candidate source and its imported graph pass TypeScript 6 with explicit Node types. `git apply --check owner.patch` passes against the current source. These are slice checks; integrator owns full app typecheck, root tests, build, ledger and commit. No hosted services, migrations or provider sessions were used.
