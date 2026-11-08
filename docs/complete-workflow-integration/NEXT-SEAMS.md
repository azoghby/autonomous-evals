# Next composition seams (inspection only)

## Appended packs

Inspected `docs/workflow-pack-integration/SERIES.json`, projection and execution
patches, operator route, retained projection and driver. Its core pin is
`48519bf16e04bce3397ceaeb8abea060d2636263`; this series uses `e61ad971…`.
`c63a67a` is an ancestor of the newer pin; the pack/redteam trees have no delta
between those pins, but applied combined tests must still be rerun.

- Execution overlaps exactly our `rich-services.ts` and `rich-evaluation.ts`.
  Add `resolvePackTarget` while keeping every data/remediation/Calendar service
  return and authority check. The old pack driver is design-only: retain data
  pending/reconciliation blockers and resolve the admitted or designed suite first,
  then require immutable pack approval **before baseline target dispatch**.
- Exact authority incompatibility: operator POST directly reads checkpoint
  `{kind:'suite',id:baseDigest}`; GET reads `{kind:'design',id:'suite:<job>:frozen12'}`.
  Approved-data admission deliberately creates neither. Use the supported Text
  `getSuite`/approved admission and retained data plan with fresh scope/authority
  checks. Do not manufacture checkpoint keys or redesign to satisfy pack review.
- Merge one immutable envelope with suite, run, investigation, `dataProvenance`,
  remediation, complete limitations and **separate** appendedPack. The pack patch's
  old rich_text.v1 assignment/input-only limitations would discard these additions.
  Its `attachWorkflowPackEvidence` uses object spread and can retain added fields.
- Projection changes `rich-artifacts.ts`, artifact download route and adds
  `workflow-pack-projection.ts`; no direct data/remediation file overlap there.
  Preserve manifest-specific authorization, secret scans, tenant/environment checks,
  draft report saving and simultaneous failure plus coverage-gap blocking.
- Three `003` app migrations coexist: data, remediation, packs. They change distinct
  objects but require distinct deployment identities. Never overwrite by prefix.
- Keep complete ordered approval/source rules and actual target, tenant/environment,
  Workflow and revocation binding. Stable `pack:<job>:baseline` cannot evade fences.
  Base12 investigation/remediation excludes appended cases. Patched-target pack
  remediation, immutable unresolved-artifact revision, authorized wakeup and complete
  artifact comparison/monitoring tick identities need explicit lifecycle design.
  Full-artifact comparison must retain union coverage/unpaired reasons separately
  from the base12 comparison. Calendar packs remain unsupported.

## Chat/build release at c06a526

Inspected via `git show c06a526:docs/chat-workflow-release/{README.md,SERIES.json}`
and servercompat README. The ordered server correction already solves duplicate
`buildAgentDeps` export/intake collision and routes data cost to canonical keys;
our data bridge independently includes those choices. Do not blindly apply that
correction or its intake files twice. Reconcile overlapping data-production source
and costs explicitly when replacing the old stager. Preserve hardened agent
bootstrap, exact approved admission and current-core hooks.

That release also has restored history/revocation UI, webpack/ESM/Tailwind build
corrections, `0002-app-source-compatibility.patch` (directory exports and IP parser
narrowing), and `0003-explicit-benchmark-refusal.patch`. These address full app build
and address validation beyond our strict entrypoint check. Integrate their existing
fixes rather than rediscovering them; none were modified or applied here. Full
Next/Workflow compilation of the final chat+data+remediation+pack release is still
a gate. Its old core overlay/Calendar hunks must not overwrite e61ad971's identities.

## Controlled acceptance at f3cb120

Inspected the commit's artifact inventory. `docs/controlled-acceptance-targets`
contains the separate internal buggy/fixed target patch, runner config/provenance
examples and Calendar handoff. It is not applied or exercised by this composition.
The final owner can compose that controlled target separately and run acceptance
with authenticated canonical scope, isolation/budget binding and real durable
receipts. Existing fixture tests are not controlled deployment acceptance.
