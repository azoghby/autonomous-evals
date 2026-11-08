# Scoped offline verification

Base `48519bf16e04bce3397ceaeb8abea060d2636263`; prerequisite Workflow series
remains at its original immutable pins. The harness overlays current-base core,
reapplies both existing producer Calendar core hunks (otherwise lost by the newer
core overlay), adds accounting, then checks/applies the remediation append. No
original frozen checks were edited. App/platform/contracts/manifests in the actual
checkout were never edited.

`node docs/workflow-remediation-integration/verification/run.mjs`:

- 23 unchanged remediation factory tests pass.
- 31 unchanged secured target adapter tests pass.
- 6 new durable accounting SQL tests pass.
- 5 new applied app composition tests pass.
- Total **65/65 across four files**, zero skips/todo, one worker. No timeout was
  increased. See [run log](scoped-tests.log).
- Strict TypeScript passes for the new accounting module and actual applied
  rich-remediation, rich-services, rich-evaluation Workflow entrypoint and operator
  binding route, with their transitive sources. Actual existing offline application
  dependencies are used; only the side-effect `server-only` marker is declared.
  No engine/SQL/SDK types are stubbed. See [typecheck log](typecheck.log).
- Archive composition and `git apply --check` pass. Harness syntax and
  `git diff --check` pass.

[Complete offline evidence](offline-evidence.json) retains the original frozen12
suite, baseline run and confirmed failed finding; complete detailed remediation
result; all twelve fresh executions and application receipts; all twelve durable
operation/reservation/usage rows and pending reconciliation records. This is
explicitly `offline_fixture_only`, with `remoteAttestation:false`. Baseline is
11/12 passing and trial is 12/12 with zero regressions. Tokens are observed, but
all twelve monetary settlements remain null and held: no dollar price or free
execution is inferred. Reconstructed service/adapter replay with zero remaining
engineer budget returns the same result without another transport dispatch.

The app tests exercise the actual core factory, target serializer, SQL checkpoint
store and accounting. Only the transport is spied to return offline responses;
canonical job/reportInput are retained fixtures. They do not run a whole hosted
Workflow, actual authentication/route requests, live provider, native PostgreSQL
restart, competing connections, private HTTP artifact reads, an outbox worker,
Next production bundling or complete app acceptance. The optional migrations are
not deployed. Core SQL tests validate reservation/delivery rollback and conflicting
replay; PGlite single-session tests do not prove distributed concurrency.

Initial failures were test/staging issues, corrected before final validation: the
app fixture's introductory wording failed unchanged objective admission; core
overlay initially dropped the prerequisite Calendar hunks; test dependencies
initially hid the complete app dependency directory during typechecking. The final
harness handles each explicitly; no assertion or frozen check was weakened.

Unknown monetary charges need authoritative owner/provider reconciliation using
the exported accounting API. There is no automatic hosted reconciliation worker
or public amount-ingest route. The separate HTTP provider ledger shares the global
cost-key protocol; the legacy final-report cost inventory still requires a union
with this ledger before a complete invoice claim. Report limitations explicitly
retain monetary uncertainty. Trace-only and unsupported patches remain unverified;
appended pack acceptance remains separately gated. Local request receipts prove
no remote model behavior or hidden-state isolation. See [acceptance boundaries](../ACCEPTANCE.md).
