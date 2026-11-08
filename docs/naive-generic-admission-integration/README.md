# Generic automated design admission candidate

> Development slice only. The current combined adoption candidate is [naive-generic-text-adoption-integration](../naive-generic-text-adoption-integration/README.md). That artifact includes later integration fixes and portable package imports; do not apply this partial slice independently or treat its earlier validation as current application acceptance.

Unapplied Track A candidate. Sole proposed source: `apps/web/src/server/naive-engine-admission-policy.ts`, with dedicated SQL tests. Actual application source, migrations and LEDGER are unchanged. No live calls, credentials, human approval or deployment.

Compose `createNaiveEngineAdmissionPolicy()` into the sibling `createNaiveMethodAuthority` dependency object. Both callbacks use only the supplied pinned SQL transaction. The sibling remains responsible for current canonical customer/job/intake/target/credential authorization.

The policy requires the current canonical binding and exact rich-engine `design` checkpoint at the stable design slot. It checks the engine input digest and full frozen body, then replays `designTextSuite` locally using only durable, completed `agent_persistence.tasks` outputs. Exact task key, role, purpose, job, environment, package, output name, pinned agent version, dispatch message and schema-valid result must match each reconstructed operation. Distinct engineer and investigator agents/sessions are required. The engine's deterministic gates and complete review/cost result must reconstruct exactly. Suite digests and review self-assertions alone cannot approve anything.

The automated approval ID hashes the complete current identity, canonical binding, engine checkpoint and durable task evidence including revisions. Fresh instances replay the same ID. Authorization reconstructs current evidence again; missing/revoked/modified tasks or changed retained checkpoint/binding reject previously issued IDs. Missing or unfinished design returns pending. This is bounded automated design admission, not expert factual certification or human review; the later rich engine still represents rubric judgments as such.

Verification uses PGlite with the actual committed agent-persistence and text-integration SQL migrations, fake completed agent outputs, and no provider transport. Tests cover stable replay, pending, foreign identity/body/job, missing review, revoked state, changed request/output/revision, forged engine review/body and supplied-transaction rollback. PGlite does not establish hosted PostgreSQL contention, live role provisioning or provider behavior.

Focused strict TypeScript is checked with retained dependencies under `/tmp/sandbox-generation-deps.cBCEai/node_modules`. Full application typecheck/tests/build and independent adoption remain integrator gates.
