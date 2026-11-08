# Standard Evals: Positioning

**One line:** Staging for AI agents: a copy of your world, thousands of simulated users, graded on what actually changed.

## Who it is for

Startups shipping high-capability agents: customer support, ops/back-office, fintech, health admin (non-clinical), voice agents. Their agents have long multi-turn workflows, many tools, large inputs/outputs, and sometimes audio or vision.

## Pains

- The agent works in the demo and breaks on the 40th turn of a real workflow.
- Every prompt or model change is a gamble; nobody can say what regressed.
- The dangerous failures are state changes: a wrong refund, a skipped identity check, a ticket not escalated, a duplicate write. The reply text can look perfect.
- Testing against production is unsafe; testing against mocks is not realistic.

## Why existing approaches miss it

| Approach | What it misses |
|---|---|
| Chat-transcript LLM judges | Grade what the agent said, not what it did. A confident reply after a bad write passes. |
| Hand-written unit tests | Cover the cases you thought of; do not simulate varied users over long multi-turn runs; do not scale to thousands of trials. |
| Production canaries | Find the failure after a customer hit it; cannot safely probe destructive paths. |

Standard Evals runs the agent against a copy of its world and asserts on the resulting database state.

## Verified proof points (true today)

- Each run executes on its own Neon database branch, with TTL cleanup (`packages/core/src/sandbox/runtime/runtime.ts` `createBranch`, `neon-branches.ts`).
- Grading checks database state: SQL state assertions and expected-change checks, kind `state` (`packages/core/src/sandbox/engine/graders.ts`).
- pass^k (`reliable` = every trial passed) with Wilson 95% confidence intervals (`packages/core/src/sandbox/engine/runner.ts`, `engine/util.ts`; stored as `pass_hat_k`, `ci95_low`, `ci95_high` in `packages/core/src/db/schema.ts`).
- Per-run budget caps that make the gateway refuse once exhausted (`budgetContext` in `engine/util.ts`; `budget_micro_usd` in `schema.ts`).
- MCP server with sandbox tools: create environment, generate suite, run, status, report (`apps/web/src/server/mcp-sandbox-tools.ts`, `mcp-tools.ts`, `docs/MCP.md`).
- Worlds built from OpenAPI, MCP servers and policies (`packages/core/src/sandbox/ingest/openapi.ts`, `mcp.ts`, `policies.ts`).
- Prebuilt sample worlds, including an Acme support world (`packages/core/src/sandbox/ingest/prebuilt.ts`, `acme.ts`).
- GitHub Action that re-runs a delivered job's frozen suite against your endpoint on each PR and fails the step on failures (`integrations/github-action/`). Scope it exactly that way: it re-runs a frozen suite, it does not build new suites.
- REST API: regression-run endpoints under `apps/web/src/app/api/v1/regression-runs`, plus sandbox routes in `apps/web/src/app/api/sandbox`. Say "REST API", do not enumerate coverage.
- Voice and multimodal scenarios exist in the scenario spec: realtime voice sockets, TTS/STT, generated images/documents/audio with a media oracle (`packages/core/src/sandbox/spec.ts`, `packages/core/src/sandbox/media/`). On the pricing page this is a Pro feature; word it as "voice and vision scenarios on Pro", not as a blanket capability for every agent.

## Not yet claimable

- Any compliance certification, SSO, or health-privacy attestation. Do not mention as available.
- Dedicated Neon project, Slack support, security review: marked "coming soon" in `packages/core/src/pricing/plans.ts`.
- "Thousands of simulated users" as a measured benchmark: the product supports large trial counts (Scale includes 25,000 trials/month), but we have no published throughput or latency numbers. Use as scale of plan, not a speed claim.
- Customer logos, accuracy numbers, or comparative benchmarks vs. other tools: none exist.
- A GitHub Action that generates new suites, or a public Python/TS SDK: not present.

## Pricing (source: `packages/core/src/pricing/plans.ts`)

| Plan | Price | Includes |
|---|---|---|
| Developer | Free | 1 environment, 50 trials/mo, sample worlds, MCP + REST, community support. Hard cap on our model spend. |
| Pro | $499/mo | 3 environments, 2,500 trials/mo, pass^k reports with CIs, GitHub Action + MCP, voice + vision, email support |
| Scale | $2,499/mo | 15 environments, 25,000 trials/mo, red-team packs, priority runs. Dedicated Neon project and Slack support coming soon. |
| Enterprise | Custom | We build your environment from your APIs, data and policies; domain-expert reviewers; volume pricing. Security review coming soon. |
| Agent Audit | $2,500 one-off | Custom sandbox, 500+ trials, failure clustering, fix recommendations, report in 72 hours |

- Overage: $0.20 per trial beyond the included trials (paid plans).
- Agent-model tokens spent on our gateway are passed through at cost (0% markup). Bring your own key and it is $0.
- Annual billing: pay 10 months, get 12 (2 months free).

### Why per-trial pricing fits heavy agents

A trial is one simulated user running one workflow end to end. Price does not grow with turns, tool calls, context length, or attachment size. Long multi-turn runs over many tools and large documents cost the same trial as a short one, and there is no markup on tokens, so heavier agents are not penalized. The only variable cost, model tokens, is visible and at cost.

## Objection handling

- **"We already have an LLM judge."** Keep it for tone. It cannot see a wrong write. We assert on the database, so a polite reply after a bad refund still fails.
- **"We have unit tests."** Keep them. They do not run thousands of varied users through 30-turn flows, and they do not report reliability (pass^k).
- **"Our world is complicated."** Start from OpenAPI, an MCP server, or policies; Enterprise and Agent Audit mean we build it with you.
- **"Is it safe to point at our systems?"** Runs hit a copy in a database branch, not production. You supply an endpoint; we never need your production credentials.
- **"What about model cost?"** Zero markup on our gateway, or bring your own key.
- **"Can it gate deploys?"** Yes for re-running a frozen suite in CI via the GitHub Action.
- **"Do you have SOC 2 / SSO?"** Do not claim either. Say: security review is coming soon, and offer a call.

## Messaging do / don't

Do:
- Lead with "staging for AI agents" and "graded on what actually changed".
- Name concrete failures: wrong refund, skipped verification, missed escalation.
- Mention pass^k and confidence intervals as the reliability measure.
- Say per-trial pricing with no token markup.
- Mark dedicated Neon project, Slack support, and security review as coming soon.

Don't:
- Never claim SOC 2, HIPAA, or SSO.
- Don't say "clinical" or imply medical-device use; health admin only.
- Don't promise throughput, latency, or customer results we have not measured.
- Don't say "replaces" unit tests, judges, or monitoring; say it catches what they miss.
- Don't describe the GitHub Action as suite generation.
