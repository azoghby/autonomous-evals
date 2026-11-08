# Private chat release verification

Release is **not accepted for deployment**. The real pinned workspace dependencies installed successfully; actual app TypeScript passed after Next type generation. The original production build fails to resolve core `.js` imports to TypeScript sources. A separate reviewed webpack/extension-alias/Tailwind correction produces successful full Next builds on both the artifact pin and the inspected current Track A tip; see the app evidence for exact commands and boundaries. This deliverable verifies a disposable
composition and supplies correction artifacts; it does not integrate or deploy
chat into the actual app. See [application/build evidence](app-ui/RESULTS.md),
[independent route/security evidence](security/RESULTS.md), and the machine-readable
[acceptance result](evidence/result.json).

The final offline run passed all seven steps: 96 structured/core tests, 15
baseline policy/SQL/file-store tests, 17 server regressions, nine original UI
interactions, 13 corrected UI interactions (including four new regressions), and
seven independent route/security tests. This is **157 passing test executions**,
with original UI cases deliberately repeated in the corrected suite; it is not
157 unique tests. Targeted server and component TypeScript also passed.

Styled Chromium evidence at 1440×1100 and 390×844 verifies actual Next/React
rendering with a synthetic API, stable failed-send retry payloads, running to
delivered polling and no mobile horizontal overflow. Both screenshots were
inspected. Computed section borders, padding, background and font verify Tailwind
processing. This does not establish live authentication or storage.

## Reproduce

```sh
node tests/track-b/chat-release/run.mjs
```

Use existing dependency caches via `STRUCTURED_NODE_MODULES` (default
`/tmp/track-b-harness/node_modules`) and `CHAT_UI_NODE_MODULES` (default
`/tmp/progress-chat-ui-verification/node_modules`). The runner never installs or
contacts services. `CHAT_RELEASE_OUTPUT` optionally chooses a directory for logs;
by default it creates a disposable evidence directory. It retains the archive and
prints its path. Exit zero means every selected offline suite passed, **not**
release acceptance. `releaseAccepted` remains false pending the owner gates below.

Real dependency compatibility is a separate, slower command (it installs only
into disposable archives using the preserved workspace lockfiles):

```sh
node tests/track-b/chat-release/app-ui/compatibility.mjs
```

Its uncorrected build failures are intentional evidence. Check its per-command
results and corrected-build outcome; none of these build checks opens a database
or authenticates a deployed session.

The runner reconstructs Track A `2dff9d8af8cccdd171d78760a0d74136d138fcb4`
with `git archive`, applies the original combined artifact, overlays core source
`de6a7985e72b57fce79ef7f69f533b0b2da126a7`, then applies the structured artifact.
It checks the combined patch equals its three ordered components. `result.json`
records SHA-256 for both patch layers, migrations and validator; it also records
current HEAD and local `origin/track-a` without fetch. The earlier combined patch
was originally based on `96cb4adcea8c55ae4d8cc353deb059996245aa77`.

The core overlay is an explicit test prerequisite, not an owner merge strategy.
The current local Track A ref has advanced to
`f0068733ca49c37f40fd7de279325f21a4b5fbbb`; application compatibility against
that tip is reported separately by the app child. The pinned archive's original
workspace manifests/lockfile are preserved by the app child for real dependency
checks. The existing structured offline validator replaces only its disposable
root manifest to support a lightweight test cache.

## What the acceptance command checks

- The existing structured SQL/projection/core tests, including positive persisted
  confirmed Text and Calendar findings and bounded missing/blocked work.
- Core current-secret policy and durable conversation SQL plus answer/file-store
  regressions against the same combined archive.
- The earlier server route/projection/composition regressions. Its copied test
  config gains a general core-source alias; its copied Trace fixture gains the
  now-required `package: trace_audit` and `environment: test` job columns. The
  original artifacts are unchanged. Without this fixture adaptation, three old
  tests fail closed before projection because their job rows omit the dispatch
  columns; this is not an application correction.
- Targeted strict server TypeScript with explicitly structural Neon/session
  declarations, and original React/jsdom interactions plus targeted component
  TypeScript. These checks are distinct from the real installed SDK/app checks.
- Independent actual route/dispatcher/core SQL security checks in PGlite.
- UI regressions that first fail on the original component, then pass with the
  proposed correction. The original artifact is never silently replaced.

No fixture test proves real session authentication, deployed authorization,
rendering, PostgreSQL concurrent transactions, Workflow production or real Neon
transport. No provider calls, service migrations, cloud deployment, spend,
secret retrieval, outreach, push or PR occurred.

## Inspected runtime boundary

The app child successfully installed actual Next 16.4.5, React 19.3.0,
TypeScript 6.0.3 and Neon SDK 1.2.0. Missing package installation is therefore
not the release blocker. Presence-only inspection found `DATABASE_URL` and
`CREDENTIALS_ENCRYPTION_KEY` absent from the execution environment, and no
preexisting local app listener. Actual sessions use the `ae_session` database
token, rather than a separate auth environment variable. No configured private
database/session was available for an authenticated deployed-job smoke test.
`postgres`, `initdb` and `psql` were also absent from the execution PATH; no
native local multi-session PostgreSQL check was performed.
Any local rendered fixture evidence in the app report is explicitly synthetic. The inspected current
Track A `evaluate.ts` still calls `services.designSuite`, `runSuite` and
`investigate`; it has no structured-inventory publisher binding. This confirms
the producer prerequisite remains relevant beyond the older artifact pin.

## Owner release prerequisites

1. Review and integrate both artifact layers and compatible core changes against
   the chosen app revision. Review the correction artifacts in `app-ui/` and
   reproduce their failing-original/passing-corrected evidence. Review `app-ui/next-esm-compatibility.patch`: it selects webpack and maps
   `.js` imports to TypeScript source, and preserves Tailwind CSS generation
   using the existing loader. Development also requires explicit `next dev
   --webpack`; the default development script is unchanged. The original default build fails; the
   corrected full build succeeds. Reproduce the intended production build
   against the final integration revision.
2. Through the existing authorized migration process, install conversation,
   checkpoint, evaluation-data and structured-inventory tables into the private
   app database. Check full real schema compatibility, server-only role grants,
   retention/deletion and native PostgreSQL concurrent replay behavior. No test
   here applied a migration to a service.
3. Verify server-only `DATABASE_URL` and `CREDENTIALS_ENCRYPTION_KEY` configuration
   through the owner's normal secret process; do not put values in this evidence.
   The latter supplies credential decryption and domain-bound HMAC references.
4. Bind real durable Text/Calendar factory dispatch and complete trusted expected
   inventory. Persist stable identities before dispatch, reconcile lost
   acknowledgements, bind generated Calendar run IDs after dispatch, and publish
   an observation watermark covering checkpoints, acquisition, job and ledger
   writes. Do not fabricate historical inventory from suite blobs/progress prose.
   Missing inventory must remain unavailable, never imply a clean result.
5. Resolve the twelve-scenario core versus appended `rt_*`/up-to-32 app scope;
   retain unknown accounting until measured completeness exists. See the original
   [structured prerequisites](../structured-progress-integration/PREREQUISITES.md).
6. Run authenticated HTTP and actual desktop/mobile browser acceptance with owned
   running and delivered jobs: send/retry/reload/history/poll, cross-user and
   public-share denial, separate operator history, sign-out/reauth recovery,
   current credential changes, positive persisted findings and missing-data
   blockers. Record session-cookie and real Neon evidence, rendered screenshots,
   keyboard/loading/error states and absence of private content on public pages.
   Only mark release accepted once these checks and normal app checks pass.
