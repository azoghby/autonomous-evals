# Calendar cross-service release checks

Source baseline: `6ff8a0642fc14dfd23842456d124a4b84f5e040a`.
Contracts are loaded read-only from local Git commit
`8634ceb30f3d98de7ec24b240a4f7549dce80033`; no fetch or install.

`cases.ts` exports callable async cases for the lead's combined scoped strict
check. `calendar.test.ts` registers just five acceptance cases. `run.mjs` stages
unchanged production sources, those cases and local contracts in a temporary
workspace, compiles strictly, and rejects failed/missing/skipped tests. It follows
the existing calendar review runner conventions without running existing fixtures.

Exact local command (existing sibling-checkout dependencies):

```sh
TRACK_B_MODULES='/Users/alexzoghby/.t3/worktrees/YC Hackathon 2/t3-6dfdf18b/tests/track-b/node_modules' node tests/track-b/cross-service-release/calendar/run.mjs
```

The default module location is `tests/track-b/node_modules`; `TRACK_B_MODULES`
allows another existing local installation. Optional `--track-a-ref <local-ref>`
selects another already-present contract revision. Preserve repository-relative
paths when combining the exported cases with other scoped checks.

Evidence checks:

- Twelve genuine calendar scenario executions retain distinct scenario scope IDs
  and the enclosing run identity through durable investigation, fresh factory
  replay, report JSON, monitoring references and progress projection.
- Three bounded reproductions confirm product failures; unreproduced failures
  retain inconclusive findings and progress blockers.
- Original target exceptions retain infrastructure outcomes, zero reproductions,
  unresolved reports, inconclusive findings and progress blockers.
- Target exceptions during reproductions stay unresolved and cannot produce
  confirmations. Unresolved evidence rejects a supplied delivered job status.
- Real reference tool sequences pass all scenarios and provide a positive control
  for completed report and independently supplied delivery status.
- Wrong run, branch, suite or input digest in trusted progress inventory rejects;
  wrong report request version and detached report branch also reject, with no
  target redispatch. These are trusted-input consistency probes, not customer
  authorization or storage-corruption exploits.

Limits: deterministic local targets only; PGlite executes production simulator,
checkpoint and journal SQL/migrations. Advisory lock functions alone are
intercepted; this proves neither native multi-session locks nor crash durability.
The simulator and application tables share the local fixture engine. The progress
reader uses a pinned fixture transaction and production checkpoint adapter;
job status, inventory and authorization are explicitly supplied trusted fixture
ports, not an application-route integration or native isolation proof. No live
provider/network/cloud calls, real secrets, deployment, spending or broad suite
runs. No production files or original tests changed.

Result: strict TypeScript passed; **5/5 acceptance tests in one file passed, none
skipped** (console evidence: `results.txt`). No current production defect was
reproduced, and no defect-characterization assertion is presented as acceptance.
Minimal exercised rejection: complete a real durable calendar investigation,
change only its expected progress inventory `branchId`, then project through the
production SQL reader: `invalid_snapshot`, with the target call count unchanged.
Restoring the expected identity permits projection. No out-of-ownership fix is
requested by this evidence.

Combined-run entry points: `calendarIdentityReplayCase()`,
`calendarUnresolvedCase('infra')`,
`calendarUnresolvedCase('reproduction-infra')`,
`calendarCleanControlCase()`, and `calendarIdentityRejectionCase()`.
Development compilation caught a missing object brace and access to an
`unknown` JSON detail field; both were corrected in these new tests before the
successful checks. No existing tests were edited to obtain green results.
