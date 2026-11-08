# Shared autonomous paid-operation reservations

`createAutonomousPaidReservationPolicy` in `packages/core/src/agents/autonomy/budget.ts` constructs target/judge/media reservation requests using the same SQL job, role-period and company-root keys as `createAutonomousBudgetLedger`. A single reservation participates in all three scopes; there is no second monetary debit. It validates the authenticated job's tenant against the supplied policy and pins the configured hold/job cap. It does not authenticate the caller, authorize transport, estimate a price or settle unknown usage.

```ts
const reservation = createAutonomousPaidReservationPolicy({
  policy, job, role: 'evaluation_engineer',
  jobCapMicroUsd: authorizedJobCap,
  reservationMicroUsd: authorizedWorstCaseHold,
});
const accounting = new PostgresRemediationAccounting({
  sql, jobId: job.jobId, reservation, deliverCost,
});
```

For Naïve retain `createAutonomousBudgetLedger(new PostgresBudgetLedger(sql), policy)`. For paid accounting use the returned reservation with its existing direct `PostgresBudgetLedger` transaction; do not wrap it again. A repeated root scope is rejected. Every writer must use the same SQL ledger, immutable job cap and role period. Mixed old/new caps or changed policy must be explicitly reconciled; the adapter never resets a scope or reinterprets past reservations. A role period different from the policy, multiple role scopes and a supplied root scope now reject before ledger forwarding.

Role keys preserve the existing `agent:<role>:<period>` contract. They are shared across tenants using that period; this addition does not silently rename historical scopes or claim tenant-specific role ledgers. Company roots use the existing tenant/period key. A lower configured role cap is bounded by the existing role definition as well. Use a stable ledger-compatible period (`A-Za-z0-9_-`) and consistent policy across all writers.

## Verification

```
AUTONOMY_NODE_MODULES=/tmp/sandbox-generation-deps.cBCEai/node_modules node tests/track-b/autonomous-company/verify.mjs
```

Strict transitive TypeScript and 48 tests across seven files passed, none skipped. Four new tests exercise actual `PostgresRemediationAccounting` and `PostgresBudgetLedger` against PGlite: mixed session/target cap competition, settled session usage and retained unknown target holds, immutable denied replay, cross-role job exhaustion, and configuration/identity rejection. PGlite serializes transactions; independent-session PostgreSQL concurrency is not established. The harness now stages exact read-only Track A contracts at `875ceef` because the new accounting test imports those transitive types. The initial run exposed missing contract staging; no source checks were suppressed.

## Remaining application work

The immutable judged application sources still construct their own role/job reservations in `rich-judge.ts`, `rich-remediation.ts` and `rich-comparison.ts`. They do not automatically acquire an autonomous root from this helper. The next owner-applyable extension must pass this policy from authenticated current job/company authority at every paid dispatch, preserve monitoring limits and use the same policy for Naïve. This source change alone is not deployed cross-service accounting acceptance.

Authoritative receipt verification, atomic keyed cost delivery, distributed locks, cancellation, policy revocation and hosted recovery remain separate obligations. Unknown provider money remains unknown; the new helper never calls `settle`. No network/provider calls, secret access, DDL deployment or spending occurred.
