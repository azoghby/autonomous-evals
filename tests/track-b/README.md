# Track B acceptance fixtures

## Isolated engine checks

Run `npm ci --prefix tests/track-b --workspaces=false`, then `npm --prefix tests/track-b run check`. This harness has its own locked dependencies and does not change Track A's workspace manifests. It copies Track B source directories and shared contracts to a temporary directory, runs strict TypeScript checking and Vitest, verifies that every selected test file actually executed with no skipped or todo tests, and removes the copy afterward. Missing source directories, directories without tests, missing contracts, or missing compatibility tests fail the run. This is an engine check, not a deployed app or live-provider check.

For an explicitly partial check, use `npm --prefix tests/track-b run check -- --components targets,simulator,judges,monitoring`. This passed strict checking and 101 tests. It does not assert completion of agents, evaluation orchestration, or reports.

### Track A contract compatibility

Pass `--track-a-ref <git-ref>` (for example `origin/track-a`, fetched beforehand; the check never fetches) to read `packages/core/src/contracts` from that exact local revision. The ref is resolved with git spawn arguments, never a shell, the contract files are staged only in the temporary directory, and the resolved SHA is printed. Without the flag, the check uses `packages/core/src/contracts` if present and otherwise fails.

Compatibility components (`contract-schemas`, `contract-targets`, `contract-branches`, `contract-evidence`, or `contract-checks` for all) live in `tests/track-b/contract-checks/` and are included in the default full check. Example: `npm --prefix tests/track-b run check -- --components targets,simulator,judges,monitoring,contract-checks --track-a-ref origin/track-a`. They assert that `createTargetServices` and `createBranchServices` satisfy the Track A `EvalServices` picks, parse target outputs against shared schemas, and pin documented gaps (UTF-8 byte cap, short suites, richer outcomes, endpoint validation, and others) in tests titled `KNOWN GAP`. See `docs/track-b-contract-compatibility.md` for the gap table, failure rules, and limitations. Their imports resolve only after staging; do not run them in place.

`trace-acceptance.json` is an independent, synthetic behavioral corpus for the Trace Audit integration. It includes positive findings and negative controls: successful actions, successful retries, honest failures, quoted customer claims, incomplete evidence, instruction violations, and malicious instructions embedded in logs.

The corpus is not yet connected to an executable engine test. Once engine services are integrated, the acceptance adapter must normalize these transcripts to the supported input shape and assert their semantic expectations. Do not treat exact model prose as stable. Preserve tool-call IDs and distinguish the assistant's claims from quoted user content.

For a finding, verify its evidence exists in the input and that its classification follows the evidence. Missing tool results can justify flagging unsupported success but cannot prove the external action failed. A tool error followed by a verified successful retry must not become a false failure.

Run deterministic checks with injected judge responses separately from real-provider acceptance. A mocked investigator does not prove the Naïve path works. Live acceptance should record model/agent versions, sessions, spend, and observed outcomes without exposing credentials or storing sensitive provider output.

Never count these fixtures as independent customers, live revenue, or external validation.

## Live SDK diagnostic

`live-naive.mjs` uses the published SDK (verified against 0.12.3). It requires `NAIVE_API_KEY`, an existing `NAIVE_AGENT_ID`, and `NAIVE_SMOKE_ROLE` (`commercial`, `engineer`, `investigator`, or `operator`). Use agents configured without external-action tools for this diagnostic. Each create reserves a provider session ceiling of 100,000 micro-USD ($0.10); four roles have a maximum combined session ceiling of $0.40. This standalone diagnostic is not customer work and does not replace production aggregate budget reservations.

Run `node tests/track-b/live-naive.mjs create /absolute/private/role-smoke.json`, then use `check` with that same path to read the existing session. Keep records outside the repository. The script refuses to overwrite a creation intent and never recreates sessions when checking. An intent without a session ID requires reconciliation, not another create. Every network request has a 30-second deadline. An idle session passes only with a clean `end_turn` and the expected validated structured output.

The SDK must be installed and resolvable from the script. Syntax and missing-key behavior have been checked; live execution remains pending credentials. Passing this diagnostic proves connectivity/structured output only, not the role-specific engine behavior or durable production persistence.
