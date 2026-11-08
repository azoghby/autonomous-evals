# Current company owner adoption: frozen 2df + approved Scout

Canonical target: `2df678268926da50d0219889fd2190b7edb6f6e8`, tree
`4be9ea6e53cbe19d043d6f2464f14df6fc7f83d4`. This is a reviewable owner-application
artifact; the actual app is untouched and hosted acceptance remains false.

`owner.patch`, `APPLICATION.json`, `BASE-INVENTORY.json` and `PIN.json` authenticate
all 2,906 owner files: 2,883 preserved exactly, 23 explicit differentials and 112
additions produce 3,018 source files. Every newer A byte survives except the explicit
Stripe receipt-ingestion addition. That route retains the entire d620 plan handler,
including `notifyPlanPurchase`. Founder approval/settings/email, migrations 0019/0020,
marketing/demo changes, current pricing/caps and the newer durable runtime composition
remain intact. The original payment F1/F2 fixes, full input binding F3, real Calendar
coverage F4 and all private chat/revocation corrections remain composed.

The exact Scout artwork and two-file patch from `28c5f8b` are appended. Its old chat
preimage is unchanged, so no hash was weakened: same component/SVG pixels, colors,
aria-hidden, no focus or animation, original heading name, 32px header and 16px answer
marks. `scout-extension/` freezes source inputs and explicit checks. No browser or
screenshot inspection is claimed; React/jsdom renders the component in the existing
isolated boundary fixture.

## Apply and verify

Use an exact file-only snapshot of the pinned commit; no `.git`, dependencies or
newer owner files may be present. Output must be empty and separate.

```sh
node docs/current-company-main-adoption/stage.mjs --from /absolute/exact-2df-snapshot --out /absolute/empty/candidate
node tests/track-b/current-company-main-adoption/run.mjs /absolute/empty/candidate review-types review-tests combined-types core-types next-typegen application-types root-tests production-build
node tests/track-b/current-company-main-adoption/scout-extension/run.mjs /absolute/empty/candidate /absolute/scout-evidence
```

Run the commands from this reconciliation artifact checkout: its control metadata
is intentionally external to the candidate. The candidate preserves historical
adoption metadata as exact pinned owner bytes; those historical README/results are
not current verification claims. Only explicit executable runner/input changes are
included within that historical namespace. This prevents recursive metadata copies.
Prior complete evidence remains immutable at commit
`79a85e790459dd0b15049f20cea0a29ff4addb31`, and in the frozen 2df base.
`HISTORICAL-METADATA.json` identifies superseded top-level reports.

The stager checks the full source domain and each preimage, applies the differential
in a disposable directory without Git metadata writes, and verifies every postimage.
`reconcile.py` records construction from the authenticated previous candidate plus
pinned owner tree; it never overlays a historical whole tree. Existing local dependency
symlinks, actual cached fonts and the offline network guard support verification.
No dependencies were installed, copied or fetched. These caches are prerequisites,
not evidence of a fresh locked install.

Measured final checks: 223 integration tests pass; unfiltered root suite has 2,829
passed, zero failed and two existing opt-in skips. Review/combined/core/app strict
types, Next type generation and Next16.4.5/Workflow production build all pass
(53 steps, four workflows). Scout strict types and all 46 checks pass. Both final
and independently staged candidates rehash to all 3,018 declared source files.
The build reports the expected offline DATABASE_URL-unset leaderboard fallback.

Final evidence is in `tests/track-b/current-company-main-adoption/final-2df-evidence/`
and `scout-extension/final-2df-evidence/`; `RESULTS.json` summarizes measured gates.
The review selection retains all 222 original assertions/tests and adds c50's frozen-clock
fairness regression with only its fixture import namespace changed (223 tests).
Scout verification retains the original 38 chat tests plus eight Scout checks.
Original review/payment namespaces are preserved; adapted execution copies are separate.

## Activation gates

`current-autonomy-owner.ts` deliberately always returns `{status: 'blocked', missing: [...]}`.
Setting environment keys alone does **not** activate company mode. Replacing that export
with a reviewed concrete `CurrentOwnerLoader` implementation remains separate code
integration, alongside policy/credential configuration. No fake provider/auth ports
were added. Owner migrations, grants, genuine adapters in every isolate, hosted auth,
Workflow replay, independent PostgreSQL contention/recovery, provider billing/receipt
proof and cross-writer reconciliation remain required. The app is not deployed or
accepted as autonomous production.

Later upstream is excluded by the exact pin, including parent-observed `b6984a1`.
Parent reports b6984a1 adds a company-agent foundation/registry/runtime, schema 0021,
research/prospecting/SDR/onboarding/CEO agents, /company UI, operator Agents tab and
onboarding chat panel (6241c99..ffb56c3). This is meaningful later integration with
potential JobView/onboarding/Stripe overlap; reconcile that authority separately.
This artifact does not silently discard those bytes: its stager refuses newer source
domains/preimages. Reconcile again before applying to a newer owner commit.
`EXCLUDED-UPSTREAM-d6203b6.*` is historical evidence only; d620 is now included.

Local log 2026-11-07: read ledger and design standards; delegated separate Scout
payload and preservation audit; authenticated frozen 2df owner tree; reconciled the
single newer app collision explicitly; appended unchanged approved Scout; added
assertion-preserving fairness coverage; ran isolated verification and stager reproduction.
Root LEDGER/Git ownership remains with parent. No app/provider/cloud/secret/spend/deploy
or migration action was taken.
