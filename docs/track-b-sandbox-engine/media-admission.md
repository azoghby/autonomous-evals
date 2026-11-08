# Receipt admission evidence

Receipt admission now resolves a missing required extraction only when two independent trusted ports provide proof. `GradeInput.perceptionAuthority` approves the attachment field, exact tool name, exact argument path, expected scalar string, and rendered asset SHA-256. `perceptionEvidence` attests completed execution and a complete final trajectory, with `hashPerceptionTrajectory` binding the actual records and the evaluated asset identities. Both bind run ID, the entire normalized scenario hash, environment hash, and suite hash.

These are server-issued grading inputs, like row authority; customer/model scenario JSON must never issue them. The expected value must agree with the authorized scenario field. The new code does not derive approval from ground truth, rubric output, assistant text, SQL result text, or an oracle's pass boolean. The runtime adapter supplies actual final records. A null control may attest the evaluated asset without claiming the target saw it; asset identity conveys no security exposure.

With valid proof, absence of the required tool or scalar argument is a deterministic failure. Every call of the approved tool must carry the approved value at the exact path; a correct call cannot hide a wrong duplicate. Invalid, missing, stale, incomplete, mismatched or duplicated proof stays unknown. Supplying any new proof disables legacy fallback, so a legacy positive binding cannot rescue invalid authority. When both new fields are absent, existing `PerceptionBinding` behavior is unchanged, including unknown for absent arguments.

The existing `bridgeGateGrade` already aggregates resolved perception leaves into required media checks. No bridge rule needed changing. The production `createSandboxEngine.propose` obtains the new evidence through its existing trusted `gateEvidence` port. Admission continues to require actual oracle success, complete failed null/empty/dump controls, and targeted mutation failures.

## Offline acceptance and regression commands

```
node tests/track-b/sandbox-media-admission/run.mjs
SANDBOX_GRADING_NODE_MODULES=/tmp/workflow-bootstrap.JpxCTM/node_modules TRACK_A_REF=74fab97 node tests/track-b/sandbox-grading/run.mjs
node tests/track-b/sandbox-media-admission/text-regression.mjs
npx tsc -p apps/web --noEmit
npm test
```

The admission runner preserves all exact Track A sandbox files from `74fab979e252971382f44cbeb88cd062fcf8f4ad` in a temporary stage, overlays Track B source, and strictly compiles before running the new tests plus the unchanged media/integration regressions. No package installation or external fetch is performed. Existing installed offline dependency locations can be supplied through the runner environment variables. The text runner retains the two existing cross-service text tests unchanged, with their pinned contracts and the integrated sandbox source available for compilation.

`sql-acceptance.test.ts` uses actual A SQL tool execution, PostgreSQL state and retained final snapshots, real receipt rendering, real receipt SDK oracle and target adapters with injected local fetch. It calls both `runScenarioGates` and production `createSandboxEngine.propose`, with actual deterministic grades throughout. Null/empty trajectories remain empty; dump text containing the answer fails required extraction. Targeted state, trajectory, output, collateral and media mutations fail their corresponding checks. The mutation fixture clones the full SQL image and preserves the original baseline; a parent write followed by a fork write verifies before/after images and parent isolation. Actual normalized scenario and suite hashes are asserted. No original scenario assertion is removed to obtain acceptance.

The media artifact retains unknown cost. Gate execution's local controlled transport has zero provider spend; its fixture zero is not a provider settlement receipt. No provider or network request is made. The test grants neither attack exposure nor row policy. Changed allowed-table rows without independent exact row authority remain unknown, and attacks without exposure remain unknown. The original lifecycle fixture's explicitly synthetic receipt admission is unchanged; the new acceptance test closes that gap through the production proposal path.

## Recorded validation

- Strict staged admission/media/integration: 22/22 passed, zero skipped: all 17 existing media/integration tests unchanged plus five new tests. An initial concurrent run failed without useful reporter output; the new runner now prints failed assertions, and the isolated rerun passed. All 79 pinned A sandbox source files were retained byte-for-byte.
- Strict grading regression: 29/29 passed unchanged against the integrated `74fab97` spec.
- Strict text regression: 2/2 existing SQL restart cases passed unchanged.
- Direct SQL/media acceptance: production gates and proposal passed.
- `npx tsc -p apps/web --noEmit`: failed on existing app schema/module/type errors, including leaderboard columns, missing `@vercel/analytics/next`, `LayoutProps`, and lite exports. No owned grading error was reported. Root dependencies were supplied by a temporary symlink to existing offline modules, removed afterward.
- `npm run build`: unavailable with the offline external dependency symlink; Turbopack refuses to resolve `next/package.json` outside the workspace root. No source/configuration changes were made to bypass this.
- `npm test`: 2,379 passed, one skipped, two failures in unchanged `targets/public-source.test.ts` and `targets/transport.test.ts`, both `blocks 198.18.0.1`. Repeating with the available alternate offline `ipaddr.js` produced the same failures. These paths are outside task ownership.

## Remaining live gates

This is offline implementation acceptance only. A production adapter must independently authorize the exact perception policy, attest completed full trajectories, verify asset provenance, and bind actual run/scenario/suite/environment identities. It must also provide exposure proof for security attacks and row authority for permitted mutations. No such permission is inferred by this change.

Live receipt rendering/oracle/target validation, provider credentials and authorization, provider usage/settlement, latency acceptance, customer approval, durable production SQL capture/replay, cloud isolation and deployment remain separate gates. Existing unknown money/outcomes are retained. No secrets, cloud resources, paid calls, deploy or push were used.

## Implementation log

- Implemented independently approved exact perception requirements and completed evidence; legacy behavior preserved.
- Added adversarial proof-binding tests and independent SQL/media gate acceptance with the two required native children using disjoint file ownership.
- Changes are restricted to grading, new admission tests, and this document. `LEDGER.md` and branch names remain untouched under this task's explicit owned-path restriction; this log is the scoped handoff.

- Final validation: staged 22/22, grading 29/29, text 2/2 passed; full root checks have the separately recorded limitations above. No original regression test was converted. No push.
