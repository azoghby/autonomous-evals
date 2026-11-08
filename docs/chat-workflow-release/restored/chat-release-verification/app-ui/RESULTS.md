# App and UI release verification

Tested 2026-11-07 locally, with no fetch of Git refs. Artifact app pin `2dff9d8af8cccdd171d78760a0d74136d138fcb4`, current local `origin/track-a` inspected pin `f0068733ca49c37f40fd7de279325f21a4b5fbbb`, core `de6a7985e72b57fce79ef7f69f533b0b2da126a7`. Both reconstructed with `git archive`, prior combined patch, pinned core source overlay, then structured patch. Actual source ownership stayed untouched. Archives are test compositions, not merge artifacts.

## Actual application compatibility

`tests/track-b/chat-release/app-ui/compatibility.mjs` reconstructs both compositions, installs their real locked workspace dependencies, executes `next typegen`, real app TypeScript, default Next build and webpack build, then applies both reviewable corrections and executes corrected typecheck/build. Logs and exact retained paths/versions/exit statuses are in `actual-app/summary.json`. It does not replace the Neon SDK, session boundary, React, Next, contracts, or core with structural fixtures. `correct-existing.mjs actual-app` resumes correction checks on the retained original test archives.

The offline installation attempt first failed `ENOTCACHED` for the analytics tarball. Normal `npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=20000` succeeded, installing 936 packages. Installed Next 16.4.5, React/React DOM 19.3.0, TypeScript 6.0.3 and Neon serverless 1.2.0. No dependency installation blocker remains. Lifecycle install scripts were disabled; the actual Next build executes its normal compilation and Workflow compiler.

Fresh app `tsc` initially failed missing generated `LayoutProps`; `next typegen` generates the actual framework declarations, after which real app TypeScript passed. This is a required generated-types ordering step, not a chat source defect.

Both original default Turbopack and webpack production builds fail because new core modules use Node ESM `.js` imports/reexports while package exports expose TypeScript source. The bundlers do not resolve these imports to `.ts`; default build reports 21 errors including missing `types.js`, `postgres-conversations.js` and projection dependencies, followed by missing exports. These are real build failures hidden by fixture alias/TypeScript-only checks.

`next-esm-compatibility.patch` preserves the core's Node ESM source contract and configures Next's `experimental.extensionAlias` for webpack, selecting webpack explicitly for the build script. It also runs the existing Tailwind loader once as a webpack pre-loader while retaining Next CSS processing; the initial webpack-only attempt visibly lost generated utilities, saved under `rendered-before-css/`. It is an owner-reviewable app configuration artifact. The final corrected webpack build completes compilation, actual TypeScript, page-data collection, 32 prerendered pages and the dynamic route table; exact per-pin statuses are recorded in `actual-app/summary.json`. Missing `DATABASE_URL` is logged by the existing leaderboard fallback during the build. This full build does not exercise authenticated chat storage or Workflow production.

## Client corrections

The original client clears private answers on authorization failure but retains its history cursor. After access restoration, Retry history skips all previously loaded answers. In-flight successful polls can also restore private text after a concurrent history response revokes access. A boolean alone is insufficient when history is restored before that old poll resolves.

`restore-history.patch` resets history/progress cursors and pagination on revocation, suppresses polling while access is blocked, and uses a revocation epoch to drop older poll/send results even after access restoration. It changes only the client artifact; server authorization remains required on every request.

`node tests/track-b/chat-release/app-ui/run.mjs [APPLIED_ARCHIVE]` proves four regression tests fail on the original applied component, then applies the exact delivered correction with `git apply --check` and `git apply` and runs strict targeted TypeScript plus all nine previous UI interaction cases and four new cases. **13 tests pass with the correction.** This harness uses React 19.2/jsdom, so it is fixture interaction evidence, not proof of React 19.3 rendering, actual sessions or deployed behavior. Saved original-failure/corrected logs accompany this report.

## Runtime and release boundary

Presence-only inspection found neither `DATABASE_URL` nor `CREDENTIALS_ENCRYPTION_KEY` in the execution environment; no values were inspected. The app's real session module reads the `ae_session` cookie and resolves its opaque token through the database; it does not require a separate auth-signing environment variable. Existing local TCP listeners were inventoried before starting our disposable app; no configured owned authenticated chat runtime was identified. No remote service request, migration, provider call, customer credential access or deployment was attempted.

Required release evidence remains actual authenticated running/delivered jobs, independent users and operator-private conversations against migrated native PostgreSQL/Neon, private table grants/lifecycle, real Workflow durable inventory producers, and deployed session/public-share isolation. The successful production build and synthetic browser fixture do not remove those prerequisites.

The correction selects webpack for production `npm run build`. For development use `npm exec -w web -- next dev --webpack`; the existing default `dev` script still selects Turbopack and has not received an ESM extension-alias correction. The rendered runner selects webpack explicitly. This artifact does not claim default Turbopack development compatibility.

## Actual rendered component evidence

`render.mjs CORRECTED_DEPENDENCY_ARCHIVE [OUTPUT]` launches a disposable Next development app with a dedicated synthetic fixture page, applies the exact UI correction, uses real installed Next 16.4.5/React 19.3.0 and Chrome, intercepts only chat API responses locally, and aborts external browser requests. It closes Chrome and its owned app process. This archive's `.next` is separate from both production-build archives. The artifact labels the fixture on screen.

Final `rendered/desktop-running.png` (1440×1100) and `rendered/mobile-delivered.png` (390×844) were opened and visually inspected. Panel hierarchy, readable text wrapping, input and button styling appear intact; the mobile page has no horizontal overflow. The screenshot inspection exposed the initial webpack Tailwind omission, which is corrected in the final artifact. The final computed section border is `1px`, body-area padding `24px`, panel background `rgb(17,18,20)`, and loaded font is Geist (the existing app font). The synthetic workflow exercises running and delivered progress, findings/blocker/unknown text rendering, an injected failed POST and retry with identical message ID/text, and independent history/progress polling. Exact network-operation metadata and checked styles are in `rendered/result.json`; app/browser output is `rendered/next-dev.log`. The screenshots prove real browser component/style compatibility with synthetic responses. They do not prove authenticated route/database correctness or a rendered deployed customer job.

Expected browser console errors are the deliberately injected first POST 503 and blocked external analytics/speed-insights scripts; those scripts were not allowed to contact external services. The corrected component itself rendered and completed the checked interactions.

Final status: **both exact app pins pass real application TypeScript and the complete production build with both correction artifacts applied**, including the final Tailwind webpack-loader correction. Original builds fail on both pins. `actual-app/summary.json` records original manifest/lock SHA-256 values, installed versions and every command exit; both final corrected build logs are included. `releaseAccepted` remains `false` because real authenticated storage/Workflow/deployment acceptance is not established here.
