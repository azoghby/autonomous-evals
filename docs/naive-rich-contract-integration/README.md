# Rich run contract owner adoption artifact

This artifact targets the exact current source base recorded in `manifest.json`. `owner.patch` and the source postimages are reviewable proposals, not applied source or a deployment. Each before/after SHA-256 pins file content independently of unrelated working tree changes.

`RunScenarioResult` preserves legacy boolean results and adds check-preserving assessment kinds: objective, rubric, inconclusive and infrastructure. Only objective results carry `passed`. `objectivePassed` validates complete objective checks before binary consumers can count a rich result; subjective or unavailable evidence cannot become a failed scenario.

Progress reports expose all assessment counts. Mock and lite investigation, monitoring and regression selection require explicit objective failure. Regression responses expose an additive `unassessed` count. Public scoring omits rich nonobjective rows; the public persistence runner fails closed because its existing database/reporting shape cannot retain subjective or unavailable assessment states. This prevents publishing misleading binary leaderboard scores. Legacy missing-result scoring remains unchanged.

The existing report service does not accept runs: it consumes investigated findings and remediation evidence. Rich run artifacts remain authoritative in the paired runtime integration; no subjective assessment is manufactured as a report finding. Finding lifecycle changes are outside this artifact.

Apply together with the paired `docs/naive-text-runtime-integration` artifact and its focused integration tests. The independent expert Workflow gate remains authoritative and is not replaced here. No provider operations, migrations, network, sends, commits or deployments are part of this artifact.
