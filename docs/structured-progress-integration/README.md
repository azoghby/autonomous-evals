# Structured private progress integration artifacts

Pinned local Track A: **`2dff9d8af8cccdd171d78760a0d74136d138fcb4`**. No fetch performed. This is a follow-on to the Trace-only private chat artifacts at base **`96cb4adcea8c55ae4d8cc353deb059996245aa77`**. The prior `docs/progress-chat-integration/combined.patch` **must apply first**. Apply that combined patch or its components once, never both.

These files are artifacts only. This commit changes only `docs/structured-progress-integration/**`. It does not modify the app, contracts, core, manifests or platform. No cloud migration, deployment, provider call, network request, spend, outreach, secret retrieval, push or PR occurred.

## Application order

1. Reconstruct the exact Track A pin in a disposable archive for review, or use the owner's authorized checkout. Check/apply the prior `combined.patch`.
2. Integrate the compatible Track B core modules. Offline validation explicitly uses immutable core source pin `e47a852737e7aca7d2fa984c363abe58f5c0ad05`; it is not part of the application patch. Integrate the parent's separate omitted-findings and report-basis corrections before release. [Prerequisites](PREREQUISITES.md) identify the remaining gaps and required evidence.
3. Check/apply `backend/structured-progress.patch`. Review `backend/001-structured-progress.sql` as a separate private migration artifact alongside existing core checkpoint/acquisition/conversation migrations. No runtime path applies DDL.
4. Bind the rich factory calls and complete expected inventory through the owner's Workflow. The pinned legacy Workflow cannot produce these identities yet. Do not enable a historical structured job by manufacturing an inventory from its suite blob, descriptions or progress events.
5. Run the offline validator below, then the owner's full application checks and authenticated live checks after actual integration. Offline success does not establish rendered or deployed acceptance.

The server reader composes `createDurableProgressProjection` and `createDurableProgressReader` with existing get-only PostgreSQL checkpoint and tenant/job acquisition stores inside the existing pinned REPEATABLE READ read-only chat transaction. Structured jobs require authoritative inventory; only Trace Audit takes the prior bounded Trace path. Missing, ambiguous and unassessed work remains blocked. Reads do not claim operations, resume Workflow or invoke providers.

The existing route, private user/job conversation scopes, current credential policy and HMAC references are retained. Stored checkpoint prose, data cases and raw responses never become chat text. Costs use the existing bounded app ledger with unknown additional/final cost retained; no measured core session is invented from an app ledger row. The persisted inventory observation watermark bounds freshness; request time is never progress evidence.

Text and Calendar run/investigation formats and evaluation-data blockers are covered. The core engine remains literal twelve; Track A's appended rt_* pack and up-to-32 contract capacity remain an unknown separate scope. The parent's core finding projection/report-basis repairs are mandatory separate prerequisites; no empty finding projection is accepted as evidence of a clean product.

## Reproduce offline

```sh
node docs/structured-progress-integration/verification/validate.mjs
```

Use `STRUCTURED_NODE_MODULES` to select an already installed offline dependency cache (default `/tmp/track-b-harness/node_modules`). The runner uses `git archive`, never a shell worktree, install or fetch. It checks/applies both artifact layers, explicitly overlays pinned core source as a test prerequisite, executes actual patched SQL/projection code against PGlite and retains the disposable archive for inspection. See [verification results](verification/RESULTS.md) for exact commands, counts and boundaries.

PGlite is one local PostgreSQL engine, not native multi-session isolation proof. Session/pool boundaries in request tests are local fixtures. Neither fixture credentials nor fixture provider outcomes establish real acquisition, authentication, customer-target behavior or accounting. No live UI/browser/render acceptance is claimed. No UI files are changed by this follow-on, so no new visual design decisions were made.
