# Owner-applyable sandbox query parameter fix

Patch base: Track A `875ceef6a743df41736ee55c4145ca794e0854a8`. `parameters.patch` changes only the sandbox runtime `query` implementation, in a disposable verification archive. Actual Track A files are untouched.

The shared `SandboxRun.query(sql, params?)` contract accepts positional values, but `run.ts` discards them and always calls the driver with `[]`. PostgreSQL rejects `SELECT $1::text` with `bind message supplies 0 parameters, but prepared statement "" requires 1`.

The patch forwards bound values and snapshots them before queueing. It does not interpolate values, broaden allowed SQL, change the read-only transaction/timeout/row cap, or run migrations.

```sh
node tests/track-b/runtime-parameter-fix/run.mjs --before-fix
node tests/track-b/runtime-parameter-fix/run.mjs
```

Before: strict compilation passes; two parameter regressions fail and the read-only/parameterless control passes. After: strict compilation, clean patch application and all three tests pass. Tests execute the exact runtime and PostgreSQL SQL through PGlite, including SQL-shaped text treated as data and nested values mutated before the queued read. No provider or cloud calls occur; this is not hosted isolation acceptance.

Default dependencies are existing `/tmp/workflow-bootstrap.JpxCTM/node_modules` (runtime AI SDK imports) and `/tmp/sandbox-generation-deps.cBCEai/node_modules` (test fallback). Override `RUNTIME_INSTALLED_MODULES` / `TRACK_B_NODE_MODULES`; no installation or fetching is performed. Track A should apply/check against its current head and rerun its runtime suite before deployment. The separate missing `executed` flag and final-snapshot lifecycle are not addressed by this patch.
