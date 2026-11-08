# Owner acceptance after applying the series

This is an offline integration artifact. Applying a patch or passing an offline
fixture does not establish deployed Workflow, provider, human review, or payment
acceptance. No deployment is authorized by this deliverable.

Before enabling real jobs, the application owner must:

1. Integrate the pinned compatible Track B sources with Track A, review the patch
   series, and run the owner's complete application checks. The archive overlay
   in `stage.mjs` is a reproducible test composition, not a production merge plan.
2. Review/apply the separate application-storage migrations transactionally through
   the normal migration process, including existing agent, conversation,
   checkpoint, acquisition, inventory and investigation persistence. Apply the
   simulator migration only to its isolated simulator database. Verify server-only
   database permissions, pinned transactions, bounded pool deadlines and session
   advisory-lock behavior in the actual Neon connection mode. No request runs DDL.
3. Configure the existing authenticated session and operator allowlist, encrypted
   canonical target credentials, stable target configuration versions, branch
   ownership/resolution, private artifact backend and current secret policy.
   Verify all four provisioned agent versions against the existing verified
   provisioning API. Stable budget period/namespace identities must survive a
   redeploy; changing them must never replenish an exhausted reservation.
4. Supply only secured target/Gateway ports backed by the existing DNS-pinned,
   bounded HTTPS transports. Verify actual provider prices, monetary caps,
   pre-dispatch reservations, measured usage persistence, duplicate/late settlement
   and reconciliation of unknown usage. A target's missing monetary usage is
   unknown cost. It is never a fabricated zero or a Naïve session charge.
5. Admit independently reviewed calendar suites from authorized storage. For data
   acquisition, register expected tasks before starting and bind review intake to
   a real independently authenticated human authorized for that task. Inspect
   provenance, source permissions, exact-answer evidence, consent and quality
   gates. Missing review must leave data pending. Expert outreach remains a draft;
   this series does not authorize sending, hiring or payment.
6. Reconcile deliberately ambiguous target/session/freeze/checkpoint operations
   against their original saved identity and actual external evidence. Never
   delete a claim, expire a reservation or mint another operation ID to retry an
   unknown external effect. Establish an operational escalation and recovery path.
7. Exercise unpaid real-mode Trace, Text and Calendar jobs through the deployed
   Workflow, including known-buggy/fixed fixtures clearly marked internal,
   redeploy between phases, duplicate wakeups, lost acknowledgements, exhausted
   budget, missing judge/reference/review, revoked credentials and unresolved
   infrastructure. Confirm stored rich JSON retains all checks and reproductions
   and reports do not label unknown evidence as passing.
8. Recheck authenticated private report/suite/evidence download and chat from the
   owner, another customer, an operator and an unauthenticated session. Verify
   authorization on replay and revocation, no public storage URLs or secrets,
   nonempty confirmed findings and inventories that block missing work.
9. Keep the twelve-scenario engine scope explicit. The appended `rt_*` pack and
   up-to-32 contract capacity require a separately agreed rich execution,
   investigation, evidence, remediation and inventory contract. A rejected scope
   is an integration blocker; disabling the pack must be a conscious owner choice.
10. Complete the plan's Stripe signature, duplicate/missed webhook, ownership,
    budget and recovery gates before any live customer payment. Verify independent
    credential/branch cleanup schedules, authorized notification transport and
    customer-confirmed findings. No offline result establishes these outcomes.

Unsupported product phases and exact remaining implementation steps are recorded
in the series README and per-layer notes. Configuration requirements must not be
filled with permissive authorization, fake port successes or permanent placeholder
HTTP responses.
