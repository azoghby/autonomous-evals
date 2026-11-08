# Current runtime source adoption package

This **147-file source/test patch (43 modified, 104 added; no deletions)** consolidates the accumulated Naïve runtime candidates into one exact source patch against actual `track-a` at `fbedc75d1ede96e792a72119ac606d10ade41fe4`. Main `ca17ce9` is preserved; its recent changes were deployment/company-cycle ledger receipts, not runtime source changes. The desired implementation is the verified bounded-run composition at `f03edc8`.

**This patch is not applied and is not deployment-ready.** Earlier expert26/factual39 approvals are already reflected in the baseline. They do not authorize this cumulative delta. Apply only this exact cumulative patch if separately approved; never replay the overlapping historical owner patches.

## What it changes

The patch connects shared budget admission and receipt accounting, durable stage ownership/recovery/cancellation, expert sourcing policy and consent, internal agent tools and initial copilot dispatch, generic remediation, judge attempts and independent incurred-cost reconciliation. Bounded design/run recovery reuses retained evidence while refusing uncertain dispatch. Current Track A app features and actual strict-conformance scripts are preserved.

These capabilities are at different readiness levels. A completed target response does not settle target monetary usage; the latest recovery flow can retain its result while the parent remains pending. Initial copilot dispatch is not long-lived conversation or idle continuation. Broad Phase 0/roster, all-method conformance, full monetary/budget coverage, native PostgreSQL and hosted acceptance remain open.

## Review and adoption boundary

Read `manifest.json` and `owner.patch` with [scope-review.md](scope-review.md) and [activation-review.md](activation-review.md). The patch includes application/database/integration source and protected core design/judge files, so the approval must cover this exact manifest across both track ownership boundaries. Approval would adopt source only: no migration, configuration change, deployment, provider call, outreach or spending.

The manifest pins every committed baseline path and mode. Review assemblies export the current runtime/test/configuration inputs and required SQL, then overlay only listed postimages; unrelated historical documentation is not hydrated into the review directories. Applying the scoped patch preserves all 4,178 existing paths outside its delta. Missing paths in an older sparse assembly are not deletions. Existing untracked files, including customer recruitment work, are outside this package. Generated build files and private environment files are not adoption inputs.

`sql-inventory.json` records source-controlled SQL prerequisites and identical-content aliases. It is not an applied-migration receipt or executable order. Ordinary Drizzle deployment does not install these sidecars. Existing lite/customer/chat paths also query new budget/stage/cancellation schema, so disabling Naïve flags does not eliminate migration requirements. Review live schema/data and obtain separate migration/deployment authorization before rollout.

## Verification

Use `assemble.py <unused-directory>` to reproduce the cumulative source tree, and `verify.py` to check independent patch application and reproduction. Final tests/types/build and preservation results are recorded under `validation/`. Historical candidate test counts remain historical evidence; this package must be checked against its own current baseline.

No actual source adoption or live operations occurred while preparing this package. Source approval, migration/configuration, hosted acceptance and deployment remain distinct actions.

Final verification: independent patch application and two fresh assemblies match all **2,412 exported files**. All **1,395 final source files** and execution inputs match the already-verified composition, so its **4,609 passing tests, types and build** are carried forward with explicit hash evidence. The only exported differences are preserved `.env.example`, CI/gitignore and the updated ledger. Current actual source independently passes **4,152 tests and web types**. Both audits pass; source adoption and deployment remain separate. See `validation/results.json`.
