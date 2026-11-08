# Durable copilot initial dispatch candidate

Status: **unapplied source candidate**, six new source/test files plus additive SQL. Requires the separate 13-file `naive-internal-mcp-integration` candidate first. Neither artifact is an adoption receipt. Actual Gateway chat, application routes, provider configuration and production are unchanged.

Repository review checkpoint: `2f921db`; fetched main remains `5da0635`. Application/core/scripts/configuration are identical to the preceding MCP artifact's `9c23982` code baseline. `assemble.py` verifies and reproduces that artifact, then applies this layer. It does not include the factual39 or sourcing26 candidates, which are independent pending owner layers.

## Implemented in staged source

- `naive-copilot-store.ts`: AES-256-GCM encrypted exact create body, bound to a digest of immutable dispatch/task/customer/job/environment/thread/turn/pin identity. Task capability is deliberately model-visible in the initial message, never metadata, headers, logs or plaintext replay storage. The generic credential-refusing runner is unchanged.
- One initial dispatch per owned job conversation and one per internal task. Changed-body/idempotency replay and a second create for the thread are rejected. A pinned SQL transaction reserves all model-ledger scopes before persisting intent. Leases fence stale workers. The durable state becomes ambiguous **before** calling the provider.
- `naive-copilot-dispatch.ts`: one bounded recovery pass. An uncertain create never triggers another create, token replacement, or key rotation. Bounded list discovery requires exactly one candidate; authoritative `get` verifies provider ID, metadata, role pin and usage. Missing/duplicate/mismatched/unmeasured results remain held. Parked resumable idle sessions keep their reservation. This conservative implementation does not automatically replay even the same create key.
- Measured terminal usage replaces the reservation and inserts an immutable cost outbox atomically. Overage is retained rather than clipped. Settlement can reconcile after capability expiry or revocation. Failed terminal sessions revoke their read capability. Successful publication authenticates the current owner, checks current job/environment/credential/configured pin, validates question digest, reads a current projection and persists the reply before revoking the task in the same transaction.
- Reply validation is deliberately conservative: only exact equivalence to the deterministic `answerProgressQuestion` result is accepted; every other schema-valid paraphrase also falls back. This is a safe initial verifier, **not** evidence that the plan's under-1% fallback/mismatch gate has passed.
- `naive-copilot-accounting.ts`: delivers retained measured usage through the actual `settleCost` application sink and acknowledges it in one transaction. Lost acknowledgement retries do not double charge. Owner/environment conflicts and legacy receipt conflicts remain unacknowledged. The legacy agent enum is respected: copilot attribution is metadata, not a fabricated legacy role.

Trusted composition must supply a fresh authenticated owner resolver, the **current** configured copilot pin, encryption key, job cap and budget period from existing server policy. Missing owner/pin resolvers fail closed. The SDK adapter is reused as a transport; there are no live calls in verification. Never expose store methods or trusted callback inputs directly as customer APIs.

## Budget and lifecycle boundaries

Maximum initial task reservation is the actual company manifest's $0.30; explicitly lower positive limits work. Agent scope is `agent:copilot:<configured period>` at $20, matching the existing runner's period convention (`NAIVE_BUDGET_PERIOD_ID`, otherwise UTC month). The job scope is `job:<job ID>` at the trusted job cap. An additional customer/environment/day scope is $2. These are **shared agent-persistence model reservation scopes**, not a proof that all company costs fit a total cap: ordinary Workflow/Gateway costs and reservations use other accounting paths. Activation requires a bridge across those paths; caller-provided new period/day strings must never bypass existing policy.

Successful settlement precedes publication. Between those transactions, the task remains readable until publication, explicit revocation or its original five-minute expiry. Publication is one-shot; its durable conversation record must be read under fresh owner authorization on a lost-response retry. This artifact exercises that storage port but does not mount the history endpoint or route fallback. Failed terminal sessions revoke immediately; unresolved creates retain their budget. Expired or explicitly revoked **undispatched** reservations currently remain held and require reconciliation; there is no automatic release or cancellation worker here.

Only the first session creation is implemented. The governing plan still requires **one session per conversation, subsequent `sessions.send`, cumulative/delta accounting, renewed per-turn capabilities, streaming, pending/retry/history UX, authenticated idle reconciliation, production runtime composition, and the `CHAT_COPILOT=naive` route switch**. Creating another session per question is expressly blocked by this SQL schema. Existing immutable `naive:<session ID>` receipts cannot represent changing cumulative costs, so sends must not be enabled against this final-only accounting model.

## Verification and reproduction

`validation/results.json` records the final checked outputs. Focused tests exercise actual PGlite SQL, real encryption/token issuance, fake provider transport, deterministic grounding, private conversation persistence and the actual cost sink. They include a lost create response, stale worker fencing, malformed/parked provider responses, publication rollback/revocation, cost acknowledgement rollback, ownership change and no plaintext capability in retained rows. PGlite does **not** establish native PostgreSQL contention behavior.

```sh
python3 docs/naive-copilot-dispatch-integration/assemble.py /tmp/new-copilot-stage
cd /tmp/new-copilot-stage/apps/web
npx --no-install next typegen
cd ../..
npx --no-install tsc -p apps/web --noEmit
npm test
cd apps/web
NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/new-copilot-stage/font-mock.cjs NEXT_TELEMETRY_DISABLED=1 npx --no-install next build --webpack
```

The local installed dependency tree is retained, not a fresh locked-install CI receipt. `owner.patch` adds only this layer's six source/test paths after the MCP prerequisite. SQL stays separate and must be reviewed/applied through the owner's migration process after authorization. No real database migration, secret registration, Naïve provisioning/session, customer outreach, spending, deployment, browser acceptance or source adoption occurred. Native PostgreSQL locking, provider reconciliation, hosted acceptance and full Naïve-plan gates remain open.
