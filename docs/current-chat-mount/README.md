# Current job private chat mount

Owner handoff only: no checked-in application, core, manifest, marketing, sandbox or historical artifact bytes are changed. `integration/owner.patch` changes two current app UI files after the exact current-autonomy candidate has been composed. See `integration/README.md` for viewer/owner/operator binding and legacy/rich progress behavior.

The initial candidate is pinned to parent `039851736eabb94e85c2c111bbccc78374716275`, current integration `28356f2` (upstream `f88811c`). The reviewed client is preserved byte-for-byte at SHA-256 `5edecb09d3d9c6b4f920d570af78c4f5b9b2ce99f55ced563a1764a2260c456b`. Chat is mounted only after a successful matching job detail load, with component identity reset on job navigation. Public routes receive no private payload or new imports.

## Reproduction

After the reviewed privacy artifacts are committed locally:

```sh
CHAT_PRIVACY_COMMIT=<reviewed-commit> node docs/current-chat-mount/stage.mjs --out /absolute/empty/stage
CURRENT_CHAT_MOUNT_STAGE=/absolute/empty/stage node tests/track-b/current-chat-mount/run.mjs
node tests/track-b/current-chat-mount/ui/run.mjs /absolute/empty/stage /absolute/evidence/ui
CHAT_REVIEWED_PRIVACY_ROOT=/absolute/privacy-checkout node tests/track-b/current-chat-mount/privacy-review.mjs /absolute/empty/stage
```

When shared Git metadata is unavailable, the user approved pinned-file composition: set `CHAT_EXACT_CANDIDATE` to the retained original candidate and `CHAT_REVIEWED_PRIVACY_ROOT` to the privacy checkout instead of `CHAT_PRIVACY_COMMIT`. Every original candidate inventory hash and every reviewed patch hash is verified before applying; the unsafe uncorrected mount is refused. No secrets or .env files are read or copied. Dependencies and retained font files come from existing local caches, with an allowlisted subprocess environment and outbound network guard. No installation or hosted service calls are performed.

`PRE-MOUNT-COMPOSITION.json` retains the complete starting inventory in the disposable stage; `CURRENT-COMPOSITION.json` records final composed source hashes and the small explicit change set. Verification checks the final inventory again after build. The stage runner cannot overwrite an existing nonempty output.

## Verification limits

UI evidence uses actual staged JobView, JobPrivateChat and useLiveJob source with React/jsdom; detail hooks, live transport and layout dependencies are scripted boundaries. Keyboard checks cover focus/form semantics; responsive checks cover wrapping classes. No browser default keyboard behavior, screenshots, pixel layout, hosted cookies, hosted database concurrency, providers or deployment were verified. No fake product progress is written. Synthetic test answers and progress remain in fixtures only.

The project root ledger and branch remain outside this task's explicitly restricted ownership. This local handoff log substitutes for a root LEDGER.md edit; the local artifact commit stays on the assigned task branch.

Log: 2026-11-07 — read ledger, tracks and global design standards; delegated disjoint mount and interaction scopes; created minimal exact-source owner mount and offline applied-source checks; coordinated privacy fixes with their owner. Composed all five exact reviewed privacy patches, including publication-result reauthorization; final mounted checks pass38 UI plus31 server/SQL tests. Final full application typecheck and119 current-autonomy tests pass. The full Next16.4.5/Workflow production build passes with local cached dependencies/fonts; root npm test exits0 with2385 passed, zero failed, and one existing live-Neon case skipped; full core typecheck also passes; release acceptance is false. Git add/commit is blocked by dataless shared Git metadata.

Additional unfiltered check: the inherited verifier excluded `tests/track-b/autonomy-paid-app-integration/acceptance-baseline.test.ts`. This handoff removes that exclusion. The omitted suite was also run separately on the final five-patch source and failed during collection because its existing eval-services mock lacks `NAIVE_AGENT_ENV`, imported by current-agent-deps.ts. No assertions were weakened or historical fixture files changed. See `evidence/acceptance-baseline.log`. This prevents an all-green claim even if the remaining app checks pass.

Final verification:38 UI +31 server/SQL privacy +119 current-autonomy checks pass on the five-patch mounted candidate. Full app/core typechecks and Next16.4.5/Workflow production build pass. Root npm test:2385 passed,0 failed,1 pre-existing live-Neon test skipped (no hosted DB access). The separately executed historical acceptance-baseline suite fails collection as documented above. Post-build inventory contains no drift. The duplicate production build started by the serial verifier was stopped after its app/core typechecks completed; the independently completed full build is retained under evidence/app. No extra build success is claimed. No browser or hosted-auth verification occurred. Local commit attempt was blocked and terminated; see COMMIT-BLOCKED.md.
