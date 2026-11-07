# Track B acceptance fixtures

## Isolated engine checks

Run `npm ci --prefix tests/track-b --workspaces=false`, then `npm --prefix tests/track-b run check`. This harness has its own locked dependencies and does not change Track A's workspace manifests. It copies the five Track B source directories and shared contracts, if present, to a temporary directory, runs strict TypeScript checking and discovered Vitest tests, and removes the copy afterward. Missing source directories or no discovered tests fail the run. This is an engine check, not a deployed app or live-provider check.

At harness creation, its syntax and missing-source failure were verified; integrated engine checks remain pending implementation.

`trace-acceptance.json` is an independent, synthetic behavioral corpus for the Trace Audit integration. It includes positive findings and negative controls: successful actions, successful retries, honest failures, quoted customer claims, incomplete evidence, instruction violations, and malicious instructions embedded in logs.

The corpus is not yet connected to an executable engine test. Once engine services are integrated, the acceptance adapter must normalize these transcripts to the supported input shape and assert their semantic expectations. Do not treat exact model prose as stable. Preserve tool-call IDs and distinguish the assistant's claims from quoted user content.

For a finding, verify its evidence exists in the input and that its classification follows the evidence. Missing tool results can justify flagging unsupported success but cannot prove the external action failed. A tool error followed by a verified successful retry must not become a false failure.

Run deterministic checks with injected judge responses separately from real-provider acceptance. A mocked investigator does not prove the Naïve path works. Live acceptance should record model/agent versions, sessions, spend, and observed outcomes without exposing credentials or storing sensitive provider output.

Never count these fixtures as independent customers, live revenue, or external validation.

## Live SDK diagnostic

`live-naive.mjs` uses the published SDK (verified against 0.12.3). It requires `NAIVE_API_KEY`, an existing `NAIVE_AGENT_ID`, and `NAIVE_SMOKE_ROLE` (`commercial`, `engineer`, `investigator`, or `operator`). Use agents configured without external-action tools for this diagnostic. Each create reserves a provider session ceiling of 100,000 micro-USD ($0.10); four roles have a maximum combined session ceiling of $0.40. This standalone diagnostic is not customer work and does not replace production aggregate budget reservations.

Run `node tests/track-b/live-naive.mjs create /absolute/private/role-smoke.json`, then use `check` with that same path to read the existing session. Keep records outside the repository. The script refuses to overwrite a creation intent and never recreates sessions when checking. An intent without a session ID requires reconciliation, not another create. Every network request has a 30-second deadline. An idle session passes only with a clean `end_turn` and the expected validated structured output.

The SDK must be installed and resolvable from the script. Syntax and missing-key behavior have been checked; live execution remains pending credentials. Passing this diagnostic proves connectivity/structured output only, not the role-specific engine behavior or durable production persistence.
