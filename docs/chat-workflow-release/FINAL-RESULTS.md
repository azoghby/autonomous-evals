# Final current-core composition

Corrected source application, real app TypeScript, full webpack/Workflow production build and seven actual anonymous route checks passed locally. Deployment acceptance remains **false**. Production ownership is unchanged.

Inputs: Track A `f0068733ca49c37f40fd7de279325f21a4b5fbbb`, current core `48519bf16e04bce3397ceaeb8abea060d2636263`, Workflow artifact `5f513d1`, historical chat correction `d7cd083`, plus the owned corrections in `SERIES.json`. The child's old-core `5906961` failures are retained under `ui/evidence/`; they are not the final composition.

## What ran

- `verify-series.mjs`: all nine patches checked/applied, all 48 restored Git blobs matched, root lock/manifests preserved. See `APPLICATION-RESULTS.json`.
- `ui/compatibility.mjs` with `CHAT_UI_OUTPUT=.../final-verification`: matching-lock installed cache copied, no install; actual Next typegen, application TypeScript and complete production build exit 0. Webpack and the real Workflow compiler succeeded. See `final-verification/{summary.json,typegen.log,typecheck.log,build.log}`.
- `transport.mjs`: 49/49 tests passed on the applied current-core transport. The pinned installed parser first failed its existing `198.18.0.1` refusal test; `0003` adds explicit benchmark-range refusal. The failure and passing rerun are retained. HTTPS and DNS are mocked by the existing tests, so no provider requests occur.
- After adding `0003` to the retained build archive, actual app TypeScript passed again (`after-benchmark-typecheck.log`). The full build was not repeated for that one runtime guard; the successful full build includes every other final correction and the server route.
- `ui/render.mjs STAGE OUTPUT --routes-only`: seven actual Next HTTP routes passed, including chat history/poll/same-origin POST 401, foreign-origin chat POST 400, data-review GET and both POST origins 403. Chat failures retained `private, no-store` and `Vary: Cookie`. See `final-verification/routes/actual-routes.json` and `routes.log`. The browser and owned server closed afterward. No duplicate screenshots were generated.
- UI regression runner checks the original component fails all four new revocation/history regressions, then the exact history patch passes strict component TypeScript and all 13 interaction cases. Current run evidence: `final-verification/ui-tests.log` and `ui/evidence/interactions/`.
- Server child: seven applied helper tests plus strict actual SDK server/Workflow/review-route TypeScript passed, with mocked canonical sink; `servercompat/RESULTS.json` records this distinct boundary.

## Reproduction and limits

Use the commands in the root README with the existing caches. For the route-only follow-up, use the stage printed by the build runner and pass a distinct output directory plus `--routes-only`. A clean future compatibility run includes `0003` before its build. No installation, cloud/provider calls, secrets, spending, outreach, push, PR or migration was performed. Dependencies and local font substitution are described in `ui/README.md`; actual Next 16.4.5 / React 19.3.0 / Workflow 5.4.0 / TypeScript 6.0.3 were used for app checks. Font retrieval used retained local Geist assets rather than network acquisition.

These route checks establish anonymous compilation and denial only. They do not establish deployed auth, private PostgreSQL concurrency, signed-in cross-user/operator/public isolation, current-credential revocation against storage, real Workflow production/recovery or provider provenance. The child's earlier styled desktop/mobile fixture inspection still applies to the unchanged UI correction; final verification did not claim new screenshots. Data admission, appended packs, remediation, complete metering and current parent core fixes remain the exact limitations recorded in the root README and server migration handoff.
