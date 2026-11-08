# Standing-policy expert sourcing integration candidate

Status: **unapplied source candidate**, layered on the 39-file `naive-factual-workflow-integration` candidate. Neither layer is deployed by this work. The previously approved accounting/expert and text-adoption patches are already actual source and must not be reapplied. This candidate preserves current Track A app behavior, Revenue, Feedback and expert review navigation.

## Behavior

An operator configures one immutable envelope for an exact customer, environment and expertise topic. The customer separately accepts a versioned disclosure for the canonical input of an eligible factual evaluation. An unchecked checkbox and explicit topic selection are required; testing permission and an expert's own opt-in are not customer sharing consent.

When the selected factual evaluator retains a missing-reference proposal, the installer derives the exact request hash from that retained proposal and the configured topic. It checks the current secured target, retained selection, customer consent, envelope bounds and existing spending policy, then installs the grant, scope and plan in one transaction. Later prerequisite failures roll everything back. New eligible jobs do not need individual operator scope setup.

Only qualified opted-in experts can be invited automatically. Cold contacts still require founder approval. Existing limits remain $25 per evaluation and $50 per day. Policy configuration does not change those limits. This candidate performs no outreach or spending during setup or verification.

Derived authority is checked again at runtime. A dedicated direct PostgreSQL session holds policy then job advisory mutexes from final dispatch authorization through the provider call and status recording; no row transaction spans the network. Customer revocation takes the job mutex, policy revocation the policy mutex. Failed lock acquisition/health checks fail closed. A send that already started can complete; revocation cannot recall a message or remove incurred obligations. Claimed/ambiguous sends retain the existing no-blind-resend fence.

Consent and grants cannot be rewritten or re-enabled. A new evaluation is needed after consent revocation. To renew a standing policy, explicitly revoke its predecessor and issue a new immutable policy ID; prior grants remain bound to their predecessor. Existing non-factual legacy scopes must have the explicit `legacy_configured` discriminator. Factual metadata cannot use that legacy escape hatch.

## Review surfaces

- Customer: owner-only sharing section on `/jobs/[jobId]`; no sharing form for unsupported or unselected jobs.
- Operator: `/operator/expert-sourcing`, linked from the existing console; configure, list and revoke exact envelopes. The existing evidence review queue remains separate.
- Private same-origin JSON endpoints: `/api/jobs/[jobId]/expert-sharing` and `/api/operator/expert-sourcing`; bounded bodies, safe status-only projections and fresh session/role checks.
- Additive SQL: `sql/001-expert-sourcing-authority.sql`. It creates immutable policy/consent/grant tables and the scope discriminator. It is a reviewable migration artifact, not an applied migration or a registered Drizzle journal entry.

## Reproduce

`manifest.json` pins current source, the required prior candidate manifest, every layered pre/postimage and SQL hash. `owner.patch` is the incremental source patch **after** the prior 39-file candidate. Do not apply it directly to current actual source. The assembler validates both layers against their exact preimages and links the installed dependency graph; it never reads/copies `.env` files or runs providers.

```sh
python3 docs/naive-sourcing-authority-integration/assemble.py /tmp/sourcing-review
cd /tmp/sourcing-review/apps/web
npx --no-install next typegen
cd ../..
npx --no-install tsc -p apps/web --noEmit
npx --no-install tsc -p packages/core --noEmit
npm test
cd apps/web
NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/sourcing-review/font-mock.cjs NEXT_TELEMETRY_DISABLED=1 npx --no-install next build --webpack
```

See `validation/results.json` for the exact completed checks. SQL tests use PGlite and dispatch tests use fake providers. Session-lock tests mock PostgreSQL responses. Browser interaction, real multi-connection contention, provider delivery, hosted Workflow restart, credentials, migration application, deployment and full Naïve Phase 0 acceptance are separate open gates. No browser inspection is claimed. The production activation decision must include both source layers and this SQL artifact; the existing source-ownership question for the 39-file patch does not authorize this extra layer automatically.
