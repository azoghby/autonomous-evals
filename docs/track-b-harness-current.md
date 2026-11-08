# Current merged-source Track B harness

The shared runner stages every TypeScript file in selected Track B components, then follows TypeScript's parsed relative imports to individual support modules. It retains imported helpers under `__tests__`, but rejects imported tests from unselected components. Compatibility tests are separate roots; support imports never select app-only sandbox tests. Unresolved imports and source roots outside agents/evals/reporting/targets/simulator/monitoring/judges/contracts/sandbox/ai fail closed.

Resources are restricted to literal relative SQL/JSON paths appearing in reached files, including the calendar test's migration array. There is no recursive SQL/JSON copy. The trace acceptance corpus continues to use the explicit `TRACE_ACCEPTANCE_PATH` environment variable. Dynamic fixture access requires an audited harness change; this mechanism does not claim to discover arbitrary runtime filesystem reads.

`--track-a-ref` resolves an existing local commit using argv-only git calls. Contracts and every reached A support module/resource come from that exact commit, never a dirty working-tree fallback. The runner prints the resolved commit, contract SHA-256 digest, and support git blob IDs, and preserves `TRACK_A_CONTRACT_SHA` for test attestations. Track B source and tests remain the working tree.

Every selected test file must appear in Vitest's JSON report with at least one assertion, and every assertion must pass. Missing, failed, skipped, and todo tests fail the run. Compiler and Vitest failures are both reported; a compiler failure no longer suppresses execution of the selected regression tests.

## Existing dependencies, no installation

`--dependency-dir` accepts an existing node_modules directory. It defaults to tests/track-b/node_modules, which is broken in this checkout. `--dependency-fallback-dir` optionally supplies missing packages; primary packages win. Only disposable staging receives package symlinks. Input dependency trees, package manifests, and production files are never changed.

The retained workflow tree has AI Gateway/Sharp but ipaddr.js 1.9.1, whose types cause five TS2349 errors in targets/transport.ts. The retained sandbox tree has ipaddr.js 2.5.0. Use sandbox as primary and workflow as fallback:

```sh
node tests/track-b/run-checks.mjs --components targets \
  --dependency-dir /tmp/sandbox-generation-deps.cBCEai/node_modules \
  --dependency-fallback-dir /tmp/workflow-bootstrap.JpxCTM/node_modules

node tests/track-b/run-checks.mjs --track-a-ref 01c05074cc7e6f8ca8af0ca16034eaec47ce7d99 \
  --dependency-dir /tmp/sandbox-generation-deps.cBCEai/node_modules \
  --dependency-fallback-dir /tmp/workflow-bootstrap.JpxCTM/node_modules

HARNESS_TYPESCRIPT_DIR=/tmp/workflow-bootstrap.JpxCTM/node_modules/typescript \
  node --test tests/track-b/harness-current/run-checks.test.mjs
```

No fetch, installation, provider call, cloud access, push, or deployment is required. The shared run bounds Vitest to two workers; PGlite SQL tests can take several minutes. It does not run independent tests/track-b sandbox acceptance runners, including sandbox-persistence/run.mjs, which has a separate owner.

## Validation log (2026-11-07)

- Targets: strict compiler passed; 6 test files, 156 tests passed, no skips/todos.
- Full pinned selection at A revision `01c05074cc7e6f8ca8af0ca16034eaec47ce7d99`: strict compiler passed; 68 test files, 1,138 tests passed, no skips/todos; Vitest duration 79.84 seconds. All seven Track B directories and all four compatibility components were selected; no regression tests were filtered out. The source graph contained 234 files and 15 pinned A support blobs.
- Harness regression checks: 13 passed, no skips/todos. `node --check tests/track-b/run-checks.mjs` and `git diff --check` passed.
- Required repository commands attempted without installation: `npm_config_offline=true npx tsc -p apps/web --noEmit` exited 1 because local TypeScript is unavailable (npx's wrong-tsc diagnostic); `npm test` exited 127 because `vitest` is not on the checkout's PATH. Neither result is represented as a pass.
- LEDGER.md was read. This scoped worker owns only the runner, new harness-current tests, and this document; the validation/change log lives here to respect that explicit ownership. The integrator can append the result to the shared ledger.
