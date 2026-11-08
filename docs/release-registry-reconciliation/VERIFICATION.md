# Local verification

Implementation verification on 2026-11-07:

- Ran the combined Node test suite in `tests/track-b/release-registry-reconciliation/`.
- Independently read the immutable judged-release manifest and the previously composed local stage referenced by `tests/track-b/judged-release/evidence/STAGE.json`. Read stage-origin source SQL and canonical application copies from that stage, and artifact-origin source SQL from the repository at the manifest's exact paths. All 31 application source/canonical hashes and the separate simulator source hash matched. This check read existing artifacts without staging, rebuilding, or changing them.
- Compared that content inventory against the explicitly synthetic empty example export: 32 pending identities, zero issues. This demonstrates content consistency and pending classification only. It is **not** an owner registry export, proof of applied migrations, or hosted acceptance.
- Independent native reviews covered the planner and CLI/documented export seam. Fixed simulator canonical-path acceptance, unknown inflight-row exclusion, and inherited CLI option names, with regression tests.

The test suite is portable; the composed-stage check requires that external local stage to exist. The tool itself intentionally requires an explicitly assembled SQL root holding both artifact and stage-origin sources. No historical files, databases, registry rows, cloud resources, or release acceptance flags were changed.

Parent verification: the original 45 tests passed. The CLI was then hardened to reject repeated JSON keys (including escaped aliases) and malformed UTF-8 rather than relying on owner preprocessing. All **49 tests passed**, none skipped. This does not authenticate an export or prove hosted schema state.
