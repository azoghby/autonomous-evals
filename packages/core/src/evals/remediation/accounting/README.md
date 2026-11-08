# Remediation accounting port

`PostgresRemediationAccounting` joins existing `PostgresBudgetLedger` operations to
its durable operation intent in one pinned PostgreSQL transaction. The trusted
reservation policy must return the operation ID as reservation ID and reuse the
workflow's job and role-period scopes. A configured reservation is a bounded
admission hold, not a claim about unknown provider price.

Bind `authorize` to the remediation factory and `beforeDispatch`, `observed`,
`ambiguous` to the actual stateless remediation target adapter. The dispatch fence
refuses every duplicate dispatch, including a fresh process with identical input.
Neither a timeout nor a lost acknowledgement permits retry or reservation release.
The local dispatch digest documents actual serialized request configuration; it
provides no remote attestation.

`observed(null)` means unknown token usage, not zero. Monetary charges remain
unknown even when token usage is measured. Reserved/dispatched/ambiguous work is
retained in a durable reconciliation outbox. Late usage can enrich unknown usage;
conflicting known observations refuse to overwrite evidence.

Only an authenticated owner/provider reconciliation process should call
`reconcile`. Its receipt ID must refer to externally retained authoritative billing
evidence. `microUsd:null` keeps the hold and pending outbox. A known amount,
including an evidenced zero, atomically settles the existing reservation, invokes
`deliverCost` and completes the outbox. `deliverCost` must use the application's
existing global `workflow_integration.cost_keys` protocol on the supplied pinned
transaction; it must not open another transaction. Target HTTP charges need their
own truthful source ledger if the legacy contract cannot represent that source.
Do not convert them into agent-session or judge charges. All writers sharing a
key must agree on the complete immutable cost payload.

Reconciliation does not manufacture an engine checkpoint, transport response or
verified repair. The owner must reconcile those separately using retained evidence.
There is no automatic outbox worker, public reconciliation route or lease stealing.
The optional migration is not deployed by this module. Runtime roles require only
reviewed DML grants, never schema ownership/DDL permissions.

The six scoped PGlite tests execute actual PostgreSQL semantics for restart replay,
identity conflicts, shared caps, cross-instance dispatch fences, unknown/late usage,
immutable settlement, and transaction rollback at reservation/delivery boundaries.
PGlite uses a single session: this is not multi-connection PostgreSQL race evidence.
