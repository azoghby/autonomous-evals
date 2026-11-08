# Factual-data Workflow source adoption

The user explicitly approved this exact 39-file patch, and its source has now been applied to the current app. All current preimages matched the reviewed manifest and all adopted postimages match exactly. It has **not been deployed or activated**, and no live migration or outreach occurred. See `adoption-receipt.json` for current verification. The original candidate details below retain their historical baseline. It is based on Track A merge `7118f3a` (main `d1ceaf0`) and supersedes the earlier operator10, generic16, guarded entry6 and selection-only candidates. Do not apply those patches on top of this one. The previous selection-only receipt is retained under `historical-c24e341-selection/`.

The candidate contains 39 source/test postimages. It preserves the current Feedback and Revenue console changes, adding only the existing expert-review navigation link. It adds no application migration, provider credential, deployment, outbound message or spending operation during assembly/validation. The separate judge owner recovery candidate is not included.

## Connected behavior

1. Trusted server configuration `EVAL_NAIVE_FACTUAL_GAPS=1`, `EVAL_SERVICES=real`, and all three selected methods (`designSuite,runSuite,investigate`) enroll new nonmock text jobs. Job, encrypted credentials and selection commit in one SQL transaction before Workflow start. Raced idempotency keys return the existing job without replacing credentials or enrolling it. Existing jobs never upgrade merely because flags change.
2. The durable profile pins design/version/admission identity and an internally assigned expert task. Legacy jobs retain `generic-text-v1`; enrolled jobs use `generic-text-factual-gap-v1`. Authority, engine replay, admission, budgets and publication use the selected profile. Disabling the factual flag or rolling back real routing holds enrolled work instead of invoking lite. Retained billing and committed delivery recovery remain independent of current execution flags.
3. A typed missing-reference proposal survives both service error wrappers and is captured inside the design step, before Workflow error serialization. SQL retains exact proposal, canonical input, owner/environment, profile and credential-aware target digest. The Workflow result contains only a bounded status; the proposal is not returned as a suite or exposed in Workflow I/O.
4. On retry, the Workflow checks durable proposal state before constructing a paid designer. Missing scope, consent, qualifications or other prerequisites keep the job pending. A validated retained proposal can release a stranded outer design-stage reservation; a failed or unknown binding cannot. The original inner provider/session accounting remains unchanged.
5. Installation requires the exact configured expert scope and policy, sharing consent and qualified contributors. The installer compares the retained target digest again under its canonical job/credential locks. Rotation between proposal validation and installation rejects. Existing consumer guards revalidate that binding before acquisition/evaluation side effects.
6. Initial owner plans and newly discovered gaps share the existing expert acquisition timers and reviewed-data consumer. The Workflow uses one pending event read across expert and generic waits, respects cancellation, counts only elapsed timer polls, and never routes the factual result into generic publication. Reviewed expert data proceeds through the adopted expert text evaluation/report path.

## Authorization and remaining gates

This wiring does **not** manufacture expert authority. The exact `expert_automation_scopes.request_hash`, enabled policy, tenant sharing consent and expert qualifications must already exist. Because proposed coverage is generated later, automatic creation of a newly proposed exact scope is still an unimplemented owner-policy bridge. Until that bridge or explicit owner configuration exists, the connected Workflow deliberately waits. Do not describe this patch as fully automatic end-to-end expert sourcing.

Opted-in experts retain the existing automatic-contact policy; new cold contacts retain founder approval. Scope installation does not itself authorize a message, approve evidence, promise payment or increase the existing honorarium limits. Independent review and provenance remain required before factual data is used.

Selection/proposal immutability is enforced by cooperating application writers under the canonical job lock, insert-once and exact digest comparison. It is not protection from a privileged SQL writer rewriting checkpoint body and digest. PostgreSQL multi-connection contention, real credentials/provider acceptance, hosted Workflow restart/cancellation and owner-policy configuration remain activation gates; the exact source adoption is recorded above. PGlite and local build results do not prove those gates.

## Review and reproduction

`manifest.json` pins the baseline and every pre/postimage. `owner.patch` is the complete source patch; it passes applicability checks against the baseline. `validation/baseline-pins.json` records the committed build/test inputs and explicit overlays. No `.env` files or production database URLs are copied into the stage.

The staged checkout uses the installed root lockfile dependency graph, with `@ae/core` bound to the staged source. The production Webpack build uses only a stage-local offline Google-font CSS fixture; no app, Next or Workflow config is substituted. Full-suite, type and build results are recorded in `validation/results.json` (final: **4,029 passed, zero failed, two documented skips**, web/core types and production build passed; 62 steps/four workflows). Browser and hosted acceptance are not claimed.

The earlier isolated test configs under `historical-c24e341-selection/tests/` describe the historical selection-only slice; run the combined candidate in a staged app tree using the repository's normal test/type/build commands. The historical owner patches remain evidence of earlier work, not additional patches to apply.

For a fresh private review tree (destination must not exist):

```sh
python3 docs/naive-factual-workflow-integration/assemble.py /tmp/factual-review
cd /tmp/factual-review
npm test -- --maxWorkers=4
npx tsc -p apps/web --noEmit
npx tsc -p packages/core --noEmit
cd apps/web
NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/factual-review/font-mock.cjs NEXT_TELEMETRY_DISABLED=1 npx next build --webpack
```

Run `npx next typegen` from `apps/web` before the first web typecheck in a fresh tree. `assemble.py` verifies committed baseline blobs and patch pre/postimages before linking installed dependencies; it does not run providers or copy `.env` files.
