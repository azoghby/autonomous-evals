# Internal MCP task authorization and progress-read candidate

Status: **unapplied application integration candidate** on actual source `9c23982`. This is independent of the factual/sourcing candidate layers. It connects an authenticated owner-issued task to the real MCP HTTP transport and a bounded audited SQL projection. It does **not** replace the current AI Gateway copilot, start a Naïve session, register live credentials, implement idle handling, or prove hosted roster acceptance.

## Implemented path

1. A signed-in owner posts `action:issue` and a UUID `requestId` to `/api/jobs/[jobId]/naive-copilot-task`. The server derives the customer identity from a fresh session lookup; operator status grants no owner bypass. Same-origin JSON and bounded bodies are required.
2. A pinned transaction locks the canonical job and resolves the one active `copilot` credential matching `NAIVE_AGENT_COPILOT`. It inserts an immutable task bound to job, customer, environment, agent/version and credential. Replay of the same request returns the same issuance, without extending expiry. Expired/revoked tasks cannot be resurrected.
3. The server signs a five-minute HMAC capability. The response is private/no-store. Raw tokens and bearer values are never persisted in task or audit rows. This endpoint issues read authority only; it does not reserve or spend provider budget.
4. A caller presents the separately provisioned role bearer to `/api/mcp/internal/mcp`, with `get_progress_snapshot` and the explicit `task_token` argument. The route uses the installed `mcp-handler` Streamable HTTP implementation. Only that tool and the needed initialization/list/ping protocol methods are available; no model-supplied job/customer selector is accepted.
5. Inside a repeatable-read transaction, the runtime rechecks current job ownership/environment, active credential, exact task claims and expiry, holding authorization locks through projection and audit. A role bearer alone cannot read a job; a task token alone cannot authenticate the internal transport.
6. The projection emits persisted status, bounded milestone/finding IDs and supported-source cost records. No prompts, excerpts, traces, endpoints, emails or provider payloads are selected into the result. Overflow and invalid records fail closed. Finding references identify persisted finding rows, not invented excerpt IDs. Proxy costs are not relabeled as Naïve; `unknownCosts` remains conservatively true.
7. Owner `action:revoke` with `taskId` blocks future reads, including on delivered jobs. Unknown or foreign task IDs cannot produce a successful revocation. Already returned information cannot be recalled.

The limiter uses atomic database counters and **fails closed** on missing/invalid persistence, independently of the public app's fail-open limiter. Issuance and reads use separate scopes; credential rotation cannot multiply a role/agent read allowance. Audit failure rolls back issuance, revocation and successful-read transactions. Denied requests return only static errors, including when denied-audit storage itself fails.

## Configuration and ownership

This source is disabled unless `NAIVE_INTERNAL_MCP_ENABLED=1`, a valid `NAIVE_AGENT_COPILOT=<agt_id>@<version>`, explicit HTTPS `APP_URL`, `NAIVE_TASK_TOKEN_SECRET` (at least 32 bytes), and a database connection are configured. Obtain credentials/signing material through the private secret form. Do not paste or commit them. Private keys and bearer values are not included in this artifact.

`sql/001-internal-mcp.sql` is an additive **unapplied** migration, not a Drizzle journal entry. It defines hash-only credential registration, immutable tasks and append-only sanitized audit rows. The actual app's existing `rate_limits` table is reused. A privileged owner must register the SHA-256 of the exact agent-bound vault bearer under the configured copilot pin after verifying the roster receipt and provider configuration. No public registration endpoint or automatic registration is included. Rotate by revoking the old row and inserting a new hash/credential identity; old task tokens then fail current authorization.

The issuer does not accept customer/agent/credential identities from JSON. The configured pin is checked again at every read. A provider session ID is deliberately absent: no verified SDK mechanism supplies it as caller authentication before the first tool call.

## SDK boundary and next implementation

Installed Naïve SDK 0.12.3 supports agent-level MCP configuration, but no per-session MCP header override in `sessions.create` or `sessions.send`. Session ID arrives only after creation. The existing durable `AgentSessionService` rejects credential-bearing messages and persists exact create bodies, so putting this capability into that runner unchanged would weaken its secret boundary.

The next copilot integration must deliberately treat the scoped task token as a **model-visible capability** delivered in the initial task input, with a dedicated encrypted replay record, stable dispatch/idempotency identity, atomic budget reservation before create, measured cost settlement and no redispatch of ambiguous creation. The observed provider session ID can be attached afterward for correlation, not retroactive authentication. Capability expiry/revocation and safe handling of long-running sessions must be coordinated. Actual conversation streaming/history and numeric/finding validation must be connected before claiming the copilot uses Naïve. This artifact does not substitute for that work.

Idle callbacks remain a separate missing route: authenticate wakeups, fetch authoritative provider state, persist idempotently and reconcile usage. A callback body must not establish tool approval or measured cost.

## Verification and reproduction

`manifest.json` pins every pre/postimage and SQL hash; `validation/baseline-pins.json` pins the exact current-source build inputs. The assembler copies no `.env` files and links the installed dependency graph with `@ae/core` resolved to staged source.

```sh
python3 docs/naive-internal-mcp-integration/assemble.py /tmp/internal-mcp-review
cd /tmp/internal-mcp-review/apps/web
npx --no-install next typegen
cd ../..
npx --no-install tsc -p apps/web --noEmit
npm test
cd apps/web
NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/internal-mcp-review/font-mock.cjs NEXT_TELEMETRY_DISABLED=1 npx --no-install next build --webpack
```

Focused tests exercise real PGlite SQL and actual MCP HTTP requests without starting a server. The composed issuer→token→read→revoke test uses the production adapter and real SQL enum types. Review corrected limiter outage behavior, duplicate success audit placement, unknown-task revocation claims the migration's environment enum/text comparison, and UUID canonicalization before signing so replay remains exact. See `validation/results.json` for completed checks.

No browser checks, native PostgreSQL contention, live vault injection, provider session dispatch, migrations, deployment, outreach or spending occurred. Current tests do not prove those gates. Applying this source requires the app owner's review/authorization; earlier approvals for separate patches do not apply to this candidate.
