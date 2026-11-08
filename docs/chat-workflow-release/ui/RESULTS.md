# Local UI and actual-app verification, 2026-11-07

Release acceptance is **false**. The UI correction is applyable over the pinned
chat + structured + Workflow composition. Targeted client TypeScript and all 13
interaction tests pass; four added regressions fail on the original component.
The complete application still has independently recorded integration blockers.

## Commands and outcomes

All commands ran locally from this repository. No install, fetch, cloud/provider
call, secrets, migration, push, PR, or production/source checkout modification.
Only disposable archives were executed.

1. `node tests/track-b/chat-workflow-release/ui/run.mjs`: exit 0. Reconstructed
   the exact `5f513d1` Workflow series, tested the original component (4/4 new
   regression cases failed), applied the byte-identical d7cd083 history patch,
   ran targeted strict TypeScript (exit 0) and 13/13 interaction cases (passed).
   React 19.2.0, Vitest 3.2.4 and jsdom fixture evidence; no actual session/store.
   Logs: `evidence/interactions/`. This executed before the server patch arrived;
   the final stage runner now also includes that patch on future runs.
2. `node tests/track-b/chat-workflow-release/ui/compatibility.mjs`, followed by
   the same command with
   `CHAT_UI_STAGE=/var/folders/dv/3krq9pqj29d7rz_qkckc6zqh0000gn/T/chat-workflow-ui-eiwicn`:
   final exit 1. First invocation exposed a test-runner preload path quoting
   issue before executing Next; fixed by copying the guard into the disposable
   path. No app source change was needed. Final evidence in
   `evidence/summary.json`: `npm exec -w web -- next typegen` exit 0;
   `npm run typecheck -w web` exit 1; `npm run build -w web` exit 1.
   The only full build **did not include** server correction `a54ab05`.
   Workflow compiled 47 steps / 1 workflow, and webpack compiled successfully
   in 36.2s; Next's TypeScript stage failed with four TS2349 overload errors
   at `packages/core/src/targets/transport.ts:19–20`. No build acceptance is
   claimed. Logs: `evidence/typegen.log`, `typecheck.log`, `build.log`.
3. `node tests/track-b/chat-workflow-release/ui/render.mjs /var/folders/dv/3krq9pqj29d7rz_qkckc6zqh0000gn/T/chat-workflow-ui-eiwicn`:
   **pre-server run exit 0** after fixing the runner to wait for the existing
   client-side sign-in redirect after hydration. Actual anonymous GET history,
   GET poll and same-origin POST returned 401 with `private, no-store` and
   `Vary: Cookie`; foreign-origin POST returned 400. The actual job page
   redirected to sign-in; the public sample did not expose the private chat
   heading. The dedicated fixture page imported the real corrected component
   into the composed Next app and intercepted chat responses synthetically.
   It exercised running/delivered polling and failed send + identical ID/text
   retry. Screenshots at 1440×1100 and 390×844 were opened and inspected:
   clear panel hierarchy, readable wrapping, styled input/buttons, no horizontal
   mobile overflow. Computed styles: 1px border, 24px padding,
   `rgb(17, 18, 20)` background, existing Geist font. Evidence preserved in
   `evidence/pre-server-rendered/` (JSON and images).
4. `node tests/track-b/chat-workflow-release/ui/final-check.mjs /var/folders/dv/3krq9pqj29d7rz_qkckc6zqh0000gn/T/chat-workflow-ui-eiwicn`:
   exit 1. Read server patch directly with `git show
   a54ab05341856eb59a42f1e204a6cf89df19356b:docs/chat-workflow-release/servercompat/0001-current-core-server.patch`,
   applied it with check/apply only to the disposable archive. No server-owned
   output was edited or cherry-picked. Final typegen exit 0; final typecheck
   exit 2 with the same four transport errors plus three TS2307 module errors:
   `@ae/core/evals/data/postgres-operations`, `@ae/core/evals/data/discovery`,
   `@ae/core/evals/data/discovery/persistence`. The first source file is absent
   from core pin `5906961`; the latter are directory entry points incompatible
   with the retained `./* -> ./src/*.ts` package export. Actual review-route
   GET and POST return 500 during webpack compilation because the first import cannot
   resolve, rather than the expected anonymous 403. Continuing the route sweep then returns 500 for subsequent chat requests and the job-page sign-in wait times out due to failed dev compilation; no final server-inclusive screenshots are claimed. See `final-typecheck.log`,
   `final-render.log`, `final-summary.json` and `rendered/next-dev.log`.
   The final server-inclusive full build was **not repeated**: the known
   transport blocker remained, and the actual route exposed the added missing
   prerequisite directly. The earlier successful browser fixture does not
   establish final server-inclusive application acceptance.

## Dependency and execution boundary

Retained cache `/tmp/workflow-bootstrap.JpxCTM` has the exact pinned lock SHA-256
`ba4727ddbc1432f67d29057306f9fec030b92cdcb60cf4cd851882200d70cf8b`.
Copied installed packages: Next 16.4.5, React/React DOM 19.3.0, root TypeScript
6.0.3, Neon 1.2.0 and Workflow 5.4.0. No checked installed package was missing.
The missing internal core sources/entry points above are composition blockers,
not authorization to install packages. Next's Google-font hook reads retained
local Geist CSS/woff2 files. This is an explicit local-font substitution, not a
clean font-fetch build. Node app children use a minimal environment and socket
guard; browser routes abort external requests. Chrome and owned server processes
are closed after each runner. No real credentials or configured private database
were used. Authenticated running/delivered job pages, current-secret revocation
against storage, and deployed Workflow production remain unverified.

## Integration handoff

Keep both UI patches in order after the final server/core prerequisite manifest.
Do not bypass app TypeScript or fabricate missing data modules to accept this
release. Resolve the transport narrowing and data source/export prerequisites
in their owning integration track, then run the final app checks once against
that exact composition. This child's output is confined to `ui/` docs/tests.
