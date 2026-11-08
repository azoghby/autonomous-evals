# Exact Workflow budget envelopes candidate

This unapplied increment layers over `naive-design-recovery-integration` at repository `e5356ba`, preserving main `ef368fc`. It adds exact stage-to-reservation accounting and host ledger injection; it does not adopt source or deploy anything.

A trusted server scope supplies the executing stage identity. Admission verifies the canonical job, current token and generation, unexpired lease, cancellation state and live parent reservation in the same SQL transaction as the child reservation. The first scoped decision retains an immutable binding; previously unbound reservations cannot acquire a retrospective discount. Local scope revocation also aborts the transaction before commit. Settlement remains available independently of the former stage owner so measured usage can still be recorded.

For each still-held parent, shared job exposure counts proven child commitments within its allowance once. Cumulative measured child usage plus unresolved child reservations must fit that allowance. Unrelated costs and unproven public receipt overlap remain additive. Exact receipt links replace a model debit only once. Releasing a parent removes its allowance, while measured costs and unresolved children continue to stand on their own. Measured overruns remain truthful and prevent new admissions; a reservation is not a provider-side guarantee of actual cost.

Host injection covers ordinary real services, generic design/run/investigation/remediation agents, expert proxy judges, and the existing remediation target reservation ledger. A target binding covers a retained commitment only: it proves neither monetary measurement nor permission to retry a target request. Unknown target money and its reconciliation outbox stay held. Expert honoraria and standalone copilot dispatch remain outside this stage model envelope. No Gateway parent-child envelope or combined customer daily ceiling is claimed.

Without the new envelope schema, unscoped legacy accounting remains additive. Explicit stage-bound admission requires the schema and fails closed if it is absent. The SQL is an unapplied migration review artifact.

Reproduce the frozen package in unused directories:

```sh
python3 docs/naive-budget-envelope-integration/assemble.py /tmp/new-envelope-stage
python3 docs/naive-budget-envelope-integration/verify.py
```

Maintainer finalization after all postimages are stable:

```sh
python3 docs/naive-budget-envelope-integration/freeze.py
python3 docs/naive-budget-envelope-integration/verify.py \
  --destination /tmp/new-envelope-final \
  --destination /tmp/new-envelope-repro
```

The manifest pins the complete parent source and SQL graph. Independent patch application, two fresh assemblies, tests, types and build are separate evidence in `validation/`. PGlite and fake provider transports do not prove native PostgreSQL contention, provider spending limits or hosted acceptance. Full receipt-sink acceptance is distinct from the exact budget-link protocol tested here.

Remaining plan gates include mixed external-child recovery, monetary reconciliation, combined daily budgets, post-delivery rerun, conversation/idle integration, expanded roster, exact source adoption and Phase 0 hosted acceptance. No credentials, provider calls, live migrations, outreach, spending or deployment are implied by this artifact.

Final verification: **4,511 staged tests / zero failures / two documented skips**, web/core types and offline-font production build (63 steps/four workflows) pass. Independent patch, two fresh assemblies and post-build audit match 2,390 source/SQL hashes. Actual-source web types and 3,956 tests pass. The skipped cases require suite regeneration or a live Neon sandbox. See `validation/results.json`. Latest observed main `8dc6c7d` adds only Track A’s demo-video ledger receipt; application/core source matches the pinned `ef368fc` baseline.
