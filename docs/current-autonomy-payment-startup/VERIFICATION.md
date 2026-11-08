# Measured offline verification

Final applied stage: `/var/folders/dv/3krq9pqj29d7rz_qkckc6zqh0000gn/T/current-autonomy-check-EAW9cP`.

Composition: exact pinned f88811c/integrated28356f2 candidate on0398517, all five independently reviewed private-authority patches in inventory order, then this artifact's owner postimages. Each review patch was hash checked and applied with `git apply --check`. The fifth corrected source hash is `c37fd134e70aa65d3fc558a872dad288562883b54e613bd5505bb45991783fc2` for `current-autonomy.ts`; the runtime/report wrapper is deliberately extended by this artifact. No historical app overlay, app/package manifest edit or core rewrite.

Passed:

- Latest payment/startup tests: **20/20**, including refusal without exclusive dispatch ownership; previous broader company/release/integration run **120/120**, no failures/skips. Counts overlap and must not be added together.
- Native PostgreSQL/PGlite persistence tests: **10/10**, actual baseline DDL in isolated fixture, not mocks.
- Independent actual-route private review rerun on this composed stage: **51/51 unique cases** (authority12 including publication3, client16, hook4, current surfaces19). Separate publication CLI also passed3/3; it overlaps authority12. In-flight cookie revocation and canonical owner transfer deny private report disclosure.
- Parent `npm test`: **2,385 passed, zero failed, one intentionally gated live test skipped**.
- Strict test compilation (rerun after the final dispatch check), production core compilation, Next type generation, full app TypeScript compilation, and the requested `npx tsc -p apps/web --noEmit` against the applied stage.
- Combined **Next16.4.5 / Workflow5.4.0 webpack production build**. Cached local dependencies and retained real Geist assets; no fresh install or hosted acceptance claim. Build logs include existing CSS warnings and expected missing-DATABASE_URL leaderboard fallback.
- Exact-current owner patch generated, checked/applied to a second fresh pinned copy, all new postimages byte compared. Final source preservation drift: **zero**, recorded by runner RESULTS.json.

Evidence: `tests/track-b/current-autonomy-payment-startup/final-evidence/`, `private-review-evidence/`, and direct SQL log under `evidence/`. The earlier initial run was superseded once final review/startup corrections were ready. A manual targeted test command initially omitted WORKFLOW_STAGE and failed only its composition harness; the corrected guarded run passed20/20.

The actual checkout lacks installed dependencies: requested `npx --no-install tsc -p apps/web --noEmit` finds an unusable tsc shim; `npm test` reports `vitest: command not found`. No install was performed. The passed commands above run real applied source using the existing allowlisted offline cache and outbound-network guard.

Shared Git metadata remains dataless and blocks read-only HEAD access. No local commit, push, metadata repair, secret, cloud action, provider call or genuine webhook was performed. User approved pinned-file composition. Production acceptance/live run remain false; README/HANDOFF retains explicit unsupported billing contracts and genuine owner/provider/dispatch gates.
