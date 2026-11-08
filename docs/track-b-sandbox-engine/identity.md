# Shared sandbox input identity

`freezeSandboxInputs(environment, scenarios)` and `verifySandboxInputs(stored)` live in `packages/core/src/evals/sandbox/identity.ts`. They consume Track A's unchanged `sandbox/spec.ts` and return detached, deeply frozen schema-normalized data with versioned SHA-256 environment/suite hashes. The suite hash includes the environment hash; object key order is canonical, array order is retained.

Semantic checks reject duplicate tools/workflows/policy clauses/scenarios/check IDs/attachment IDs, unknown workflow or trajectory/fault tool references, and an SQL binding result index outside its statement list. Empty suites, invalid Unicode/NUL, non-JSON values and oversized input are rejected with a fixed error. Persisted inputs are reparsed and both digests rechecked.

This establishes input identity, not execution authority or correctness. It does not validate SQL safety, policies, credentials, media, generated facts, oracle evidence, customer approval, or runtime isolation. In particular, `oracleValidated` is preserved as data and is never elevated into trusted admission evidence. The generation team's gate receipts must bind these inputs independently. Seeds/model/runtime versions still belong in execution evidence; this helper does not invent missing contract fields.

Verification: `node tests/track-b/sandbox-identity/run.mjs` runs strict TypeScript and 12 tests against exact Track A spec revision `aa94505fd535f5c0f586cc6325b49b71a1683761`, staged read-only from Git. No network or credentials. The general Track B harness now stages the spec from the exact `--track-a-ref` when sandbox engine code is included, prints its content digest, and refuses older refs without that contract rather than silently substituting a new schema.
