# Naïve Phase 0 acceptance and Track A handoff

Prepared from repository source after checkpoint `84ca7d2`, for the selected `docs/NAIVE_PLAN.md`. This is an execution checklist, **not a completion or deployment receipt**. Read `docs/naive-plan-progress.md` for completed local validation. Track A owns app routing, secrets deployment and database/application migrations; Track B supplies agent resources and engine code.

## Evidence boundaries

| Evidence | What it proves | What it does not prove |
|---|---|---|
| `agents/company-roles.ts`, `naive-provisioning.ts`, `naive-resources.ts` | Current source for explicit role configuration and safe resource operations | Provisioned roster, configured MCP authorization or deployed features |
| `scripts/naive-provision.ts --dry-run` | Offline inventory of intended resources and unresolved inputs | Remote discovery, drift attestation or a complete executable resource graph |
| Resource operation tests / Track B harness | Selected staged current B sources typecheck and satisfy local tests | Full current app build, hosted execution or provider acceptance |
| `docs/scenario-workflow-integration/owner.patch` and historical company artifacts | Reviewed owner-applied artifacts pinned to their documented bases | Applied current app code or production activation |
| LEDGER deployment statements | Historical operator records | Fresh verification of today's environment |

No cloud migration, provisioning, session execution, send or deployment is implied by this document.

## Local verification

Run from the repository root after fetching and checking current main. Preserve unrelated customer-recruitment files and Track A edits.

```sh
git fetch origin
git status --short --branch
git rev-parse HEAD origin/main
npx --no-install tsc -p apps/web --noEmit
npm test
node tests/track-b/run-checks.mjs --components agents,evals --track-a-ref HEAD \
  --dependency-dir /tmp/sandbox-generation-deps.cBCEai/node_modules \
  --dependency-fallback-dir /tmp/workflow-bootstrap.JpxCTM/node_modules
```

Verify retained dependency paths exist first. Missing checkout executables are failures to run the root checks, not passes. The staged B harness does not include `scripts/naive-provision.ts`; typecheck and exercise that CLI separately using the retained dependency environment or an owner-restored locked installation. Do not mutate shared dependency caches.

## Provisioning sequence and credentials

Use the private secret form for a freshly rotated `NAIVE_API_KEY`, with file delivery for CLI use. The CLI accepts `NAIVE_API_KEY_FILE` (preferred) or `NAIVE_API_KEY`. The file contains only the supplied key; never print it or commit it. Current CLI fixes the SDK origin to `https://api.vetta.sh`.

With dependencies available:

```sh
npx --no-install tsx scripts/naive-provision.ts --dry-run
npx --no-install tsx scripts/naive-provision.ts --inspect
```

`--inspect` performs read-only roster discovery and prints `configurationAttested:false`. It is not the resource attestation gate.

The apply interface consumes **explicit staged JSON operations**. The roster builder supplies dependency-checked stages; it does not automatically discover and activate the whole roster:

```sh
npx --no-install tsx scripts/naive-provision.ts --resource-plan > /absolute/private/phase0-plan.json
npx --no-install tsx scripts/naive-provision.ts --check /absolute/private/phase0-plan.json /absolute/private/phase0-journal
npx --no-install tsx scripts/naive-provision.ts --apply /absolute/private/phase0-plan.json /absolute/private/phase0-journal
```

Plan shape: `{ "operations": [ ... ] }`. Every entry has `kind` and `body`; supported kinds are `skill`, `outcome`, `vault`, `agent`, `credential`, `deployment`. Agent entries may specify `pin:{id,version}`. Deployment entries require an operation `name`; bodies require a positive budget, exact `agent_id`/`agent_version`, and `enabled:false`. Credential entries use `vaultId`, `valueFile`, and optional trusted `{id,fingerprint}`; plaintext `body.value` is rejected. These are explicit SDK input bodies, not inferred from prose.

The whole-roster builder now emits one concrete dependency stage at a time:

```sh
npx --no-install tsx scripts/naive-provision.ts --roster-plan /absolute/private/roster-config.json /absolute/private/roster-plan.json
npx --no-install tsx scripts/naive-provision.ts --check /absolute/private/roster-plan.json /absolute/private/phase0-journal
```

`--roster-plan` writes a new private `0600` output file and prints only a summary, because callback URLs may carry an idle secret. It refuses overwrite. Its config uses `stage` (`resources`, `agents`, `coordinator`, `credentials`, `deployments`), explicit `createRevisionAgents:true`, a revision name, and retained dependency receipts. Later stages require exact skill `slug@N` references, matching content hashes, agent IDs/versions/configuration fingerprints, and applicable private credential files/schedules/callbacks. It neither discovers remote state nor creates resources. See `CompanyProvisionPlanOptions` for the exact input contract. New revision names avoid modifying either legacy `ae-*` or Track A's `standard-evals-*` agents.

Run dependent stages separately: skills/outcomes/vaults → exact pinned agent configurations → agent-bound credentials → paused deployments. Discover and attest all inputs of each stage before creating missing resources. Record returned IDs/versions; build the next stage from those exact receipts. Keep the durable journal for every rerun. Pending/ambiguous operations require reconciliation; never erase a journal to force retry.

Remaining work before this is the plan's complete provisioning workflow:

- `--resource-plan` generates the four versioned skills and three bounded advisory outcomes in `company-resources.ts`. Review that content, then retain the exact returned skill references for the later agent stage. The offline inventory alone does not provision them.
- Resolve legacy agent configurations versus the expanded manifest. Existing agents are never edited/deleted by this provisioner; explicit migration/version decisions are needed. Do not mutate the unrelated organization CEO.
- Supply private per-role bearer credentials and implement Track A hash storage, task-token authorization and audited internal MCP routes before use. Credential metadata cannot attest secret bytes; the trusted local receipt records what was submitted, not provider readback.
- Supply operator schedules for Mara/Pax/Otto and a secured idle callback. Do not invent task-token/idle secrets, schedules or webhook authenticity.
- Keep deployments paused. The SDK supports creation with `enabled:false`; zero budget is **not** a pause, and `deployments.run` can run a disabled schedule.
- Bind outcomes and per-task output schemas in execution. Provisioning resource existence alone does not activate those features. Only Cass has team handoffs; the provider's org-CEO reachability caveat remains.

## Track A staging and migration steps

Create `naive-staging` from the current app main branch and a separate child of sim-seed. Resolve IDs from the provider when executing; do not assume historical IDs are current. Obtain connection credentials privately and use staging-specific `PG*`/`DATABASE_URL` configuration without printing connection strings.

Inspect migration state first: agent and ownership migrations contain plain `CREATE`, so blind reruns are not safe. Apply each once with failure-stop and a transaction using the owner migration process. Example commands below assume `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, and SSL settings already target the correct child:

```sh
# Application staging child only:
psql -X --set=ON_ERROR_STOP=1 --single-transaction --file=packages/core/src/agents/persistence-migrations/001-agent-persistence.sql
psql -X --set=ON_ERROR_STOP=1 --single-transaction --file=packages/core/src/simulator/ledger-migrations/001_branch_ownership.sql
# Reconfigure PG* to the isolated sim-seed child before this command:
psql -X --set=ON_ERROR_STOP=1 --single-transaction --file=packages/core/src/simulator/migrations/001_calendar.sql
```

`evals/integration/migrations/001-text-integration.sql` belongs to Phase 1 integration; autonomy operations SQL belongs to optional later activation. Neither should be applied merely because an older owner patch mentions it. Capture migration receipts and isolated branch identities without secrets; production migration requires the normal Track A release process.

Configure Preview `DATABASE_URL` for app staging, `NEON_SIM_SEED_BRANCH_ID` for the seed child, required Neon variables, rotated `NAIVE_API_KEY`, and four exact `<agentId>@<version>` runtime pins. The existing integration reads only the four legacy role env names; expanded manifest env names do not make new application paths active.

## Conformance and diagnostic gates

These are actual current CLI flags:

```sh
npx --no-install tsx scripts/conformance.ts --services real --skip-branching
npx --no-install tsx scripts/conformance.ts --services real
npx --no-install tsx scripts/conformance.ts --services real --target-url "$PHASE0_TEST_TARGET_URL" --target-model "$PHASE0_TEST_TARGET_MODEL" --target-key-env PHASE0_TEST_TARGET_KEY
```

Execute only after a reviewed staging/spend plan. The conformance recording contexts default to $3 each; its spend meter reports costs, it is not a shared aggregate spend cap. `--skip-suite` and `--skip-branching` are partial diagnostics, not full acceptance. Without `--target-url`, `runSuite` is skipped. Exit zero alone can coexist with skips; retain each PASS/FAIL/SKIP and require the intended checks actually ran.

Current `scripts/conformance.ts` imports `integration/eval-services` directly for `real`. Five `integration/compose.ts` methods remain unavailable: `designSuite`, `runSuite`, `investigate`, `proposeAndVerifyFix`, `rerunFinding`. Provisioning alone cannot make full conformance pass. The current app `server/services.ts` still wraps real services with `withLiteFallback`; a successful app flow under `EVAL_SERVICES=real` does **not** certify all-Naïve execution. Track A must provide routing/no-fallback evidence at the Phase 1 acceptance boundary.

`runLiveDiagnostic` is an exported function in `agents/live-diagnostic.ts`, not an executable CLI. It now requires an explicit four-role pinned `directory` and `budgetPeriodId`, validates those before provider calls, and uses read-only configuration attestation. It never provisions. Defaults and maximum allowed diagnostic envelope are the plan's $0.25/session and $1 total; lower positive caps are permitted if the total covers all four reservations. Production role task ceilings of $0.30 or higher do not raise this diagnostic envelope.

The diagnostic still uses the four tool-denied configurations and single-process `FileBackedPorts`. It does not prove PostgreSQL cost rows or expanded-role acceptance. Use a fresh run ID/state file for a new diagnostic, retain that same identity/state to resume, and record measured usage. A separate staging run must prove database settlement/deduplication.

## Exit receipts still required

- Rotated credential setup and exact role/version/resource receipts; paused deployment receipts with no run calls.
- Applied staging migration receipts and branch isolation/recovery checks.
- Real conformance with zero FAIL and all required checks actually exercised, including target execution and branching.
- Bounded role diagnostic with terminal statuses, exact schemas and measured usage; separate PostgreSQL persistence/cost dedupe/replay receipts.
- Track A Preview end-to-end receipt with method routing evidence, no lite substitution where real acceptance is claimed, and ownership/authorization checks.

Record implemented source, independently applied historical artifacts, and verified deployed behavior as separate states. None of these gates is cleared by merging this checklist.
