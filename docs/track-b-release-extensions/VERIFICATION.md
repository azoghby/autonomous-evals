# Offline verification

Reproduce from this checkout using only retained offline dependencies:

```sh
node docs/track-b-release-extensions/stage.mjs
node docs/track-b-release-extensions/build-artifact.mjs
node tests/track-b/release-extensions/comparison/run.mjs
node tests/track-b/release-extensions/lifecycle/run.mjs
node tests/track-b/release-extensions/comparison/build.mjs --build-only
```

Default dependency workspace: `/tmp/workflow-bootstrap.JpxCTM` (override `WORKFLOW_INSTALLED_WORKSPACE`). Full build also requires retained Geist CSS/woff2 at the existing cache (override `CHAT_FONT_CACHE`), and loads the predecessor's network-blocking offline preload. There is no dependency installation or font fetch. The retained dependency tree can differ from the application lock; build evidence records actual versions.

The original comparison 15 assertions are copied unchanged; only the staged migration filename changes to 006. One extra regression asserts two monitoring ticks reuse the exact same retained frozen12 suite/digest and baseline, retain rich objective/rubric outcomes and create no suite/design checkpoints. That fixture supplies an admitted retained binding; it does not establish production review authorization.

The lifecycle runner copies the original resumption tests, original final pack/chat crossflow suites and one focused review-wake/pack seam test into the same composed application. Fixture updates preserve assertions: pending expectations now distinguish review/agent/cost delivery, and intake fixtures gain the resumption schema required by the production transaction. No production path or assertion is removed to make tests pass. Original 140-test resumption selection is audited against the original RESULTS inventory.

The focused seam uses a real PGlite authenticated-review ledger and resumption intent/wake/capture/finish SQL with the actual merged rich driver. The core admission result, budget wrapper and pack/target transports are scripted boundaries. It verifies same Workflow ID, no suite design checkpoint, approved provenance retention, and pack authorization before baseline dispatch. Separate existing pack execution/authorization tests exercise pack authority; this seam is not a hosted provider or durable worker test.

The owner patch is checked/applied against a fresh archive of exact latest A, then every delivered source byte and the entire delivered file set are compared to the final inventory. Repeated generation has the same patch and inventory hashes.

No cloud SQL, migration, provider, secret, spend, deploy, outreach, push or PR action occurred. App-driver live budget remains **77/48 versus approved 32/16**, so live acceptance is blocked. Neon main and seed existence was reported verified read-only by the parent; schema, roles/grants, deployed route auth/configuration and positive budget binding remain unverified. PGlite serialization does not prove independent-session PostgreSQL locking, hosted Workflow replay/crash recovery or real target behavior. Notifications remain drafts.

## Recorded results

- `node tests/track-b/release-extensions/lifecycle/run.mjs`: **214/214 main + 7/7 chat**, zero failed/skipped, original **140** resumption assertions audited. Commit `9495fb0` owns this runner/evidence.
- `node tests/track-b/release-extensions/comparison/run.mjs`: **16/16** (all original 15 plus monitoring suite-reuse regression), strict transitive comparison/app/route TypeScript passed.
- `node docs/track-b-release-extensions/build-artifact.mjs`: fresh latest-A apply/check, full source-byte and file-set equality passed. Patch SHA-256 `6b09d9cea2231b7738248baa1813caddb650da4c6b3bc928cc28a5a558d5ef29`; final inventory SHA-256 `85b0a7ee6f6eac3555151222af16c2d3c4f5af615612fca3eccee8f89ed8cb05` (776 inventoried files).

Detailed machine-readable evidence is under `tests/track-b/release-extensions/{lifecycle/RESULTS.json,comparison/evidence}`. The completed build result follows below; compile success does not change `releaseAccepted: false`.

Final build verification completed successfully on the combined inventory above: **214 main + 7 chat + 16 Calendar + 16 comparison = 253 passed**, zero failed/skipped. The 140 historical resumption cases and 15 historical comparison cases are subsets, not additional counts. Full core TypeScript, Next type generation, full app TypeScript and `next build --webpack` including Workflow compile all exited 0. Evidence/runner commit: `774cded`.

Actual retained versions: Next **16.4.5**, React **19.3.0**, TypeScript **6.0.3**, Workflow **5.4.0**, managed-agents **0.12.3**. Build warnings include inherited CSS/autoprefixer warnings and leaderboard fallback because `DATABASE_URL` is unset; no database credential was supplied. This is an offline cached build, not a clean dependency/font install or production configuration check. Augmented-pack comparison remains unsupported/refused; enabled supported pack wake and base12 monitoring reuse were exercised at the separate boundaries described above.

`git diff --check` passes for owned source/docs excluding `application.patch`: blank context lines within a valid unified patch carry the required space prefix and are retained verbatim.
