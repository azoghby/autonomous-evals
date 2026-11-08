# Canonical comparison cost delivery

Apply `fix.patch` after the comparison app extension. This additive patch preserves historical pinned artifacts. It forwards measured Text investigation cost to `ctx.recordCost` after the comparison-local SQL transaction commits.

Validation: `node tests/track-b/comparison-cost-delivery-fix/run.mjs` passed strict applied-source TypeScript and 17 tests (15 original, two regression tests). `--before-fix` reproduces both defects: no canonical delivery and a completed tick despite canonical sink failure.

Delivery is at least once. Investigation and report assembly can deliver the same `meta.idempotencyKey`; the canonical sink must deduplicate that key and reject mismatched amounts. The regression proves one keyed charge across both callbacks and completed-tick replay. On sink failure the local cost remains durable and the tick requires reconciliation; it does not silently complete or blindly redispatch.

This is offline SQL/application validation. Final combined application adoption and production sink reconciliation remain required. No migration, provider call or deployment occurred.
