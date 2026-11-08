# Adopted Naïve runtime: rollout preparation

The actual runtime was adopted in `5d600a8` after explicit approval of the cumulative 147-file source patch. This directory prepares the next Phase 0 persistence and acceptance gates from `../NAIVE_PLAN.md`; it does not authorize or perform migration, deployment, provider calls, outreach or spending.

Read these artifacts together:

- `schema-plan.json` and `schema-plan.md`: canonical SQL paths, hashes, prerequisites, aliases and activation scopes. Historical patch copies are not additional migrations.
- `verify-schema.ts`: offline plan validation and an isolated PGlite schema rehearsal. It must not load project environment files or connect to a database URL.
- `hosted-acceptance.md`: actual commands and evidence required for current hosted routing, budgets, persistence and recovery, with missing harnesses identified.
- `validation.json`: the integrator's local checks and their limits.

## Release boundary

Ordinary `npm run deploy` runs Drizzle migrations but does not install subsystem sidecars. Existing lite/mock Workflow paths and Gateway chat query the new stage/budget/cancellation tables even when Naïve flags are disabled. Do not deploy the adopted source until the target schema has been inventoried and the separately reviewed migration sequence has passed staging and hosted checks.

The offline rehearsal starts from an empty, disposable database. It proves SQL composition in that engine, not that a partially migrated live database is compatible. Before any live application, collect the target's migration receipts and catalog state, reconcile existing task/reservation/cost rows, and review the exact remaining SQL and expected locks. A matching table name alone is insufficient: constraints, functions, triggers, grants and legacy rows matter. Non-idempotent migrations must not be replayed blindly. Rollback must retain incurred costs, unresolved holds and immutable evidence.

Native PostgreSQL contention, actual process/Workflow restarts, hosted authorization and provider cost receipts need separate evidence. A completed target response is behavioral evidence, not proof that target monetary obligations have settled. Unknown target costs must continue to hold the parent; a zero receipt must not be invented to make a job complete.

## Following the full plan

This work advances Phase 0 schema readiness; it does not replace the remaining plan. Current-role attestation and provisioning, strict real-service conformance, current persisted diagnostics, all-method routing, package-level hosted acceptance and the subsequent company/copilot/sandbox/approval phases remain separate gates. The historical four-role diagnostic is not current expanded-roster acceptance. See `../naive-plan-progress.md` for implementation versus hosted evidence.

Use a private secret form when live verification actually needs credentials. Keep live connection strings, bearer material and customer evidence out of repository receipts. Request the concrete staging migration/deployment or provider run only after its artifacts, limits and rollback are reviewable.

## Local verification

Run `node docs/naive-runtime-rollout/verify-schema.ts` for the standalone offline rehearsal, or `npx vitest run --config docs/naive-runtime-rollout/vitest.config.ts` for its regression checks. The local config is required because root Vitest does not discover docs tests. Twelve focused checks pass, including hash drift, aliases, dependency order/cycles, inventory coverage, database separation and failure/replay rejection. The current root suite passes 4,609 tests with two documented skips; web and harness types pass. The previous production build's 2,286 input hashes remain unchanged.

The runner now supports the two exact reviewed constraint replacements with explicit `--reviewed-constraints`; strict conformance still imports core composition that hardcodes five unavailable methods. App text routing is a different surface; simply changing an import would not supply its canonical job, admission and Workflow authority. App `rerunFinding` remains unwired. Keep these full-plan gaps visible even if a narrower trace-audit demo is accepted.

## Reviewed constraint runner

`node scripts/apply-sidecar-sql.mjs --dry-run --reviewed-constraints <unused-env-path> <expected-direct-endpoint-id> <canonical-file.sql>...` validates files and emits hashes without reading environment files or constructing a database client. Removing `--dry-run` performs database writes and requires a separately reviewed target-specific migration operation; no such write was performed here.

The exception is restricted by canonical physical path and code-pinned SHA-256 to `001-design-stage-recovery.sql` and `001-run-recovery.sql` in their existing integration directories. Changed bytes, copied files and other destructive SQL are refused. The tool does not infer migration order or installed state and must not replay already-applied SQL. Direct URL query parameters are limited to `sslmode` and `channel_binding` to prevent PostgreSQL driver routing overrides. Failures stop execution; an uncertain COMMIT is explicitly reported as unknown and must be inspected before retry. Per-file commits mean an earlier successful file remains applied after a later failure.

This is a trusted-operator migration utility, not a general SQL sandbox. Its reviewed exceptions do not authorize migration or replace catalog/data/grant review, native PostgreSQL validation, backups or hosted acceptance.

The supplied database was inspected read-only. `staging-schema-gap.md` and `.json` record all 33 current base migration hashes, two additional historical receipts requiring reconciliation and the structurally missing sidecars. The reports contain no credentials or customer rows. No missing migration was applied.
