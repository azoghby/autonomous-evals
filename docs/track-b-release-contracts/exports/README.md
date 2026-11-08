# Public core exports and manifest release contract

Exact source under review: local `origin/track-a` at
`8634ceb30f3d98de7ec24b240a4f7549dce80033`.
Track B parent: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`.
The runner refuses local tracking-ref drift and requires the parent to be an
ancestor of the current checkout. It never fetches. It uses `git archive` of the
exact SHA, without overlaying Track B code, into a cleaned temporary directory.

From the repository root, the entrypoint for **combined strict scoped integration** is:

```sh
node tests/track-b/release-contracts/exports/run.mjs --strict
```

Omitting the flag also selects strict mode. Its nonzero exit must propagate to
the combined release result; do not substitute characterization for acceptance.

For the pinned defect baseline only:

```sh
node tests/track-b/release-contracts/exports/run.mjs --characterize
```

Both commands emit JSON. The script finds the repository from **cwd** using
`git rev-parse --show-toplevel`, so invoke its absolute path or a suitable relative
path when running from a nested directory. It requires existing Node, Git, tar,
TypeScript and esbuild. No npm/npx, installs, network, providers, database, secret
files, or application execution are involved. Existing tools default to:

```text
/tmp/workflow-bootstrap.JpxCTM/node_modules
```

Override that ephemeral local dependency location with
`RELEASE_EXPORTS_NODE_MODULES=/absolute/existing/node_modules`. Tools are loaded
from that path, with actual versions emitted in every result. No symlink or
build output is written to the checkout or the dependency directory. The archive
and all generated bundles/probes are removed in `finally`.

## Exact observed results (2026-11-07)

- Root command `node tests/track-b/release-contracts/exports/run.mjs --strict`
  exited **1**. Full machine evidence: [strict-result.json](strict-result.json).
- From `tests/track-b/release-contracts/exports`, `node run.mjs --characterize`
  exited **0**, `characterizationPassed: true`, **`accepted: false`**.
- Node **v24.21.0**, TypeScript **6.0.3**, esbuild **0.28.2**.
- **23** distinct current production consumer subpaths plus **15** explicit
  `/index` barrels yield **34** unique probes. TypeScript bundler-mode package
  resolution: **0 unresolved**. The real TypeScript checker verified **329**
  named/default import bindings against public module export symbol tables,
  including type exports: **0 missing bindings**.
- Real esbuild bundles all 34 probes and follows relative imports/re-exports:
  **34 outputs, 0 errors, 0 warnings**. Third-party dependencies are external;
  no provider initialization occurs.
- Core exposes `"./*": "./src/*.ts"`. Explicit `@ae/core/evals/text/index`
  resolves; `@ae/core/evals/text` does not. All **15** directory aliases and
  root `@ae/core` are unavailable. No current scanned consumer requires those
  aliases; these observations are **not defects**.
- Root, core and web dependency sections match their committed lockfile entries:
  **3/3**. This confirms lockfile agreement, not package installability.
- AST dependency audit across **343** non-test implementation files found **66**
  direct imports absent from the owning package's manifest. Strict acceptance
  requires direct declarations rather than relying on sibling workspace hoisting.

| Owning package | Missing direct requirement | Import sites |
| --- | --- | ---: |
| `packages/core` | `resend` | 1 |
| `packages/core` | `dotenv` (`dotenv/config`) | 1 |
| `apps/web` | `drizzle-orm` | 42 |
| `apps/web` | `zod` | 17 |
| `apps/web` | `stripe` (explicit type-only) | 2 |
| `apps/web` | `@neondatabase/serverless` | 1 |
| `apps/web` | `@x402/core` | 2 |

## Minimal reproductions for Track A owners

These are manifest defects under the declared-dependency gate, not a claim that
the hoisted monorepo application fails today. No Track A fixes were made.

```sh
git show 8634ceb30f3d98de7ec24b240a4f7549dce80033:packages/core/src/auth/email.ts
git show 8634ceb30f3d98de7ec24b240a4f7549dce80033:packages/core/package.json
```

The source imports `Resend` on line 1, but core does not declare `resend`.
Web declares it, making core depend on a sibling's installation layout.
Core's `email/setup-inboxes.ts:6` imports `dotenv/config`; only the root
**devDependencies** declare dotenv. That site is a one-off administration script,
not evidence of a request-path dependency. It remains included because the core
wildcard exposes that source too. It is never run by this check.

```sh
git show 8634ceb30f3d98de7ec24b240a4f7549dce80033:apps/web/src/server/x402-pay.ts
git show 8634ceb30f3d98de7ec24b240a4f7549dce80033:apps/web/package.json
```

Lines 2–4 import `drizzle-orm`, `@x402/core/http`, and `@x402/core/types`;
none is declared by web. Another small example is web's
`app/api/auth/request-link/route.ts:1` importing undeclared `zod`.
The JSON evidence supplies every source path, line and syntactic type-only flag.
The audit permits devDependencies for **explicitly** type-only imports; unmarked
imports remain dependency requirements even if TypeScript could erase them.

## Limits

This is a focused export/build/declaration gate, not the full Next production
build, semantic typecheck, runtime integration suite, dependency version/range
compatibility audit, or SQL acceptance. External packages are intentionally not
bundled or executed. TypeScript's checker is used to inspect public symbol tables;
unrelated semantic diagnostics are not asserted. The audit handles literal
static imports/re-exports and literal dynamic imports/require calls; computed
specifier imports and usage-level type inference are outside scope. Source tests,
app configuration outside `src`, and future/new revisions are outside the scan.
The characterization asserts the exact pinned problem groups and counts; it
cannot silently turn existing defects into release acceptance.
