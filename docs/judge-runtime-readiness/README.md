# Default judge runtime capacity gap

Run `node tests/track-b/judge-runtime-readiness/check.mjs` after installing the existing Track B harness dependencies. This executes the actual `workflowJudgeRuntime` factory extracted through TypeScript's parser, with no provider or credential access. It characterizes a release gap, not successful acceptance.

The default production runtime permits 16 Gateway dispatches per instance. The retained accepted suite has 24 rubric checks. Calls 17–24 are refused. Current judging integration tests inject a custom meter and therefore do not prove the default runtime finishes that suite. Baseline plus remediation requires a separately bounded plan; changing a production limit must not enlarge the previously approved live acceptance cap of 16 Gateway calls.

Required integration: supply an explicit server-owned operation plan and durable dispatch budget sized to the authorized suite/phase, with monetary reservations and timeout enforced independently. Keep acceptance's lower approved cap fail-closed until separately authorized. Verify the actual default/configured application construction, not only injected fixtures. No tests should remove original rubric checks to fit the cap.

This finding is separate from the already documented 77 target / 48 Gateway full acceptance plan versus 32 / 16 approved caps. No production code or caps changed here.
