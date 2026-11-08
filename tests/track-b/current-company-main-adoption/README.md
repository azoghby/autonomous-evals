# Current-main validation

Run only against an independently staged, disposable application directory:

```sh
node tests/track-b/current-company-main-adoption/run.mjs /absolute/disposable/stage
```

Optional trailing command names select gates: `combined-tests`, `combined-types`,
`core-types`, `application-types`, `root-tests`, `production-build`.

The harness uses existing dependencies from the verified combined candidate,
including ipaddr.js 2.5.0 and Workflow/Next installed caches. It creates dependency
symlinks, temporary validation configs, and build output inside the disposable
stage. It never installs packages or edits a dependency cache. Every command
receives an allowlisted environment and the inherited offline socket/fetch guard;
no environment file or credential is copied. Local SQL fixtures are allowed.
The font shim uses retained real Geist CSS/woff2 assets; the recorded hashes identify
those font inputs. This does not verify a clean uncached installation.

The combined selection preserves all seven historical include globs, including
`acceptance-baseline.test.ts`; there is no test exclusion or skip insertion.
Combined strict TypeScript checks the selected tests and their transitive source.
Core production strict TypeScript excludes test source only; the unfiltered root
`npm test` run covers the root configuration's production-source tests.
Next typegen generates current route helpers before application TypeScript checks
the staged application's unchanged configuration.
The build runs Next with webpack, which compiles the staged Workflow application.

Evidence is written under `evidence/`; command status, exact arguments and log
hashes are recorded in `RESULTS.json`, and Vitest JSON reports preserve test counts.
A zero command exit status is necessary for a gate pass. Source preservation is
verified separately by the adoption stager/inventory, before and after validation.
No deployment, migration, provider billing, or hosted acceptance is inferred.

`pricing-compatibility.py` is an explicit transformation used by the adoption
builder, with a review copy in `pricing-compatibility.patch`. Five historical
fixtures/assertion expectations now derive checkout quantities and quote labels
from canonical `PRICE_CENTS`. Exact settled receipt matching, signed event/payment
amount matching, the one-cent mismatch refusal, and all existing assertions remain.
`PRICING-COMPATIBILITY.json` records exact pre/post hashes and unchanged assertion
counts. Budget amounts, leases, HTTP500 statuses, test timestamps and Calendar
operation counts are unrelated to checkout prices and remain intact.

Final evidence: `evidence/SUMMARY.json` records all final gate passes and the
initial disposable-setup failures preserved in the command history/previous logs.
The 164 combined tests have zero skips. Root tests pass 2,622 assertions with two
pre-existing opt-in skips (tau2 regeneration and Neon live runtime). Post-build
rehash verifies all 2,573 adopted source paths against the final repository
APPLICATION manifest: 2,460 preserved, 21 changed, 92 added, zero drift/errors.
Existing real Analytics 2.0.1 is linked from the Workflow bootstrap app-level
node_modules; its exact path/package hash is recorded.

## Independent review inputs (F3/F4)

`REVIEW-INPUTS.json` records reviewer commit `8756a5a` and exact immutable test,
support, report and fixture bytes retained in `review-inputs/`. All 16 reviewer
files stage at their original `tests/track-b/current-company-review/**` paths.
All reviewer test bodies initially remain byte-identical. The fixed variant below
records four corrected queue-count expectations in two test files. The authorization/payment
fixture has an explicit canonical-price compatibility postimage recorded in
`REVIEW-FIXTURE-COMPATIBILITY.json`; the pristine fixture remains retained.
All 63 docs fixture inputs already match the validated baseline stage exactly.
These snapshots are evidence: corrected owner migration SQL must not be overlaid
with a historical fixture snapshot.

Run `run.mjs STAGE review-types review-tests` for strict reviewer types and the
full 221-test combined selection. It verifies original review-path hashes before
running and writes separate `review-evidence/`, preserving baseline evidence.
`review-acceptance` separately selects all baseline tests plus review invariant,
finding and repro files. Full review characterization results remain separately
reported; two old drain characterizations intentionally assert the prior F1 bug.

`TEST-INPUTS.json` pins all 2,573 baseline source paths, the seven formerly unbound
tests, their docs fixtures and actual generated baseline harness inputs.
`HARNESS-INPUTS.json` maps retained exact harness/seven-test snapshots.
The reusable runner reads guard/font/TypeScript inputs from `harness-inputs/`,
uses the historical temp candidate only as an existing dependency-cache source,
and emits a fresh per-execution `TEST-INPUTS.json` including every staged source,
actual generated configs, runner hash, guard bytes and real cached font hashes.

When the separate payment-fixes extension supplies
`docs/current-company-payment-fixes/sql/002-payment-recovery.sql`, the documented
`paymentFixes` fixture variant appends that additive migration after original001
in the authorization/payment and replay payment fixtures. Exact posthashes and
`reviewer-fixture-compatibility.payment-fixes.patch` record the two support-file
changes. Original001 and all Calendar/forged-identity/SQL/refusal test bodies remain exact. The harness
requires this variant whenever002 is present; canonical-only compatibility applies
when002 is absent. The migration-only variants change no test expectations; the fixed queue corrections below are explicit.

## Final payment-correction compatibility

`PAYMENT-FIX-INPUTS.json` freezes the parent extension PIN/README/runner/patch,
all four runtime postimages, additive002 SQL and the exact new refund/reconciliation
regression. The runner includes this 222nd test in review types, full review and
the separate acceptance selection. No fixed run has been inferred from historical
results; the integrator must run the final staged source.

The generalized compatibility helper applies exactly four parent-supplied
queue-count corrections (parent payment runner lines66–73): revoked backlog25→0,
24-revoked control outcomes25→1, refunded re-selection→empty, undelivered1→0.
It preserves assertion counts and all original review payload bytes. Per-file
pre/post hashes are in `REVIEW-FIXTURE-COMPATIBILITY.json`; the separate patch
shows every change. All forged-identity, real-SQL and refusal assertions remain
exact. The baseline bridge test now imports actual `@/server/current-payment`
when fixes are staged, preserving the historical docs postimage. Its SQL port is
scripted, so it executes no migration and requires no002 append.

The first fixed-source run passed all 164 baseline and 57 reviewer tests, strict
review/combined/core/app types, root tests and production build; its new 222nd
regression exposed missing fixture cost DDL. An instrumented diagnostic captured
SQL42P01 (`workflow_integration.cost_keys` absent). A control using the exact
already-inventoried `apps/web/migrations/{001-workflow-integration,004-workflow-remediation}.sql`
passed the unchanged regression assertions. The fixed auth support fixture now
executes those two real migrations after payment002; their hashes are pinned in
`REVIEW-INPUTS.json`. No runtime or final regression body changed. Initial results
remain frozen in `payment-fixes-before-fixture-evidence/`; final revalidation is
reported separately when available.

## Stable 3f0bd8a inputs and execution namespaces

The final stable source pin is `3f0bd8a589101c9902ad50d402b7948b6dee4c68`.
That base already contains the pristine reviewer and committed payment-fix tests.
Their original paths remain preserved. Execution copies use
`tests/track-b/current-company-adoption-review/**` and
`tests/track-b/current-company-adoption-payment-fixes/**` at the same relative
depth. Mapping `stagePath` fields identify the exact executed paths. All Calendar
and invariant bodies remain exact except the four documented corrected queue
expectations. The committed regression changes only its fixture import to the
new review namespace; its stronger idempotent settlement assertions remain.

`PAYMENT-FIX-INPUTS.json` now freezes actual d55699f inputs from the authenticated
3f0bd8a base, rather than the earlier pending regression. The committed regression
loads its own cost migrations. Therefore the auth fixture now appends payment002
only; cost001/004 are supplied at the two mapped `owner-migrations/**` fixture
paths and are not redundantly executed by auth setup. Earlier pending inputs
remain retained under `historical-payment-pending-inputs/`. Successful b331
results remain frozen under `final-b331-evidence/`.
