# Independent current private chat authority review

**Release acceptance: false.** Review checkout `7f492e2cba2004eca4aeff13752a9380f602f2dc`; adoption candidate parent `039851736eabb94e85c2c111bbccc78374716275`. The exact supplied candidate and source hashes are retained in `authority/CANDIDATE.json` and `privacy/CANDIDATE-PIN.json`. Checked-in application source has no applied private chat; candidate reports `chatClientMounted=false`.

| Actual executed surface | Unchanged source | Docs-only correction |
| --- | --- | --- |
| Candidate chat route + adapter + local PGlite SQL | 6 passed, 3 strict failures | 9 passed |
| Candidate autonomous publication route + current app/release/SQL | 2 passed, 1 strict failure | 3 passed |
| Exact candidate chat React component | 16 passed | No client correction needed |
| Current/candidate live progress hook | 4 strict failures | 4 passed |
| Current job/live/artifact routes, actual session/query adapters with controlled ports | 18 passed, 1 strict failure | 19 passed |

Chat POST caches session/operator authority and credential screening across request-body consumption: revocation, operator removal, and rotating a credential into generated reply text return 200 in strict adversarial fixtures. SQL ownership transfer, next-request revocation, user/job evidence-HMAC isolation, raw evidence-ID exclusion, and missing current progress-inventory refusal pass. See `authority/RESULTS.md` for exact request boundary and reproducible failure details.

The progress hook retains old job data across switches/disabling and accepts old subscription callbacks, including fallback polling. See `privacy/README.md`. The report artifact route authorizes before asynchronous report reads and returns a report after scripted revocation during that read. The artifact patch checks current session identity and canonical owner/operator authority after reading and before constructing the response. It does not revoke bytes already streamed or prove atomic permission revocation under PostgreSQL concurrency.

## Owner composition API and patch order

`COMPOSITION.json` records exact SHA-256 hashes and a successfully applied disposable combined stage. The final five-patch composition passes all **51 unique focused cases**: combined chat/publication authority12, client16, hook4, current routes19. See `COMBINED-RESULTS.json` and `final-*.log`. Final mounted composition remains the mount owner's verification scope. Starting ONLY from the supplied exact adoption candidate, run:

```sh
node tests/track-b/chat-current-authority/compose.mjs /absolute/exact-candidate /absolute/result.json
```

This copies the candidate without dependencies/build caches and applies, in order:

1. `authority/0001-refresh-authority-policy.patch`: route/DB current authority and credential refresh.
2. `privacy/use-live-job-isolation.patch`: scope current progress callbacks and clear old snapshots.
3. `current-surfaces/recheck-artifact-authority.patch`: current report/evidence/suite response reauthorization.
4. `current-surfaces/0002-existing-owner-fixture.patch`: existing artifact test fixture supplies its authorized `customerId`; assertions unchanged.
5. `authority/0002-reauthorize-publication.patch`: reauthorize current owner/cookie after pending autonomous publication lookup and before serialization; see `authority/PUBLICATION-RESULTS.md`.

All patch paths above are relative to this document's directory. `git apply --check` runs before every application. No chat client patch is needed: preserve exact reviewed client SHA-256 `5edecb09d3d9c6b4f920d570af78c4f5b9b2ce99f55ced563a1764a2260c456b`. Do not substitute the historical unsafe route. Mount owner must compose all corrections before final mounted tests and pin new final source hashes. Patch refreshes mitigate measured request boundaries; independent connection hosted revocation remains a release check.

## Checks and practical limits

Per-child reproduction, source pins, strict uncorrected logs and unchanged-assertion corrected logs are retained. Current-surface reproduction:

```sh
node tests/track-b/chat-current-authority/current-surfaces/run.mjs /absolute/stage
node tests/track-b/chat-current-authority/current-surfaces/verify-patch.mjs
```

`npx --no-install tsc -p apps/web --noEmit` and `npm test` ran in a disposable current archive with retained offline caches. Initial cached workspace resolution produced unrelated old-core diagnostics; the corrected current-core link reduced TypeScript blockers to missing `@vercel/analytics/next`, generated `LayoutProps`, and existing target transport union typings. Full cached Vitest 5 run: 2,383 passed / 2 failed / 1 skipped; the two existing artifact tests lacked `customerId` in their owner mock after the reauthorization patch. The additive realistic-owner fixture correction passes all five existing artifact tests. A follow-up broad run with current core resolution and the corrected owner fixture passed **2,385 tests, 1 skipped**, retained in `current-surfaces/npm-test-v3.log`. Logs retained; this is not a clean locked install/build claim.

Authentication is scripted at cookie/session lookup ports. Routes, query/service adapters, SQL, React components and hooks execute; no real hosted sign-in or browser session is claimed. Remaining checks: real hosted owner/other-user/operator/public access, expired sessions and grants during requests, credential rotation and storage reads, independent PostgreSQL concurrency/transaction isolation, current inventory producer/watermark/grants/migrations, mounted running/delivered UI, real transport/cache/realtime capability expiry and durable Workflow recovery. No secrets, external services, provider/cloud calls, spend, push or owner source edits occurred.

Owned ledger: `LEDGER.md` here. Root ledger and branch were left untouched to honor explicit review-only file ownership.
