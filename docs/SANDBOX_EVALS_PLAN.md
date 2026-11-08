# Sandbox evals: evaluate any startup agent inside a copy of its own world

Status: started Nov 7 evening. Owner: Track A (Ronit) for the v0 build; Track B (Alex) is proposed as the long-term owner of the scenario, simulator and grader engine. Contract: `packages/core/src/sandbox/spec.ts` (`sandbox-spec-v1`).

## Goal

Today's evals send prompts and judge text. A startup's agent works by calling tools that change data, over long conversations, under the company's own policies. The sandbox eval runs the customer's real agent against a disposable copy of its world. We grade **what it did**: the final data, the tool calls it made, and its policy compliance. What it says it did is not graded. Every case runs several times, so we measure reliability, not luck.

## What the customer gives us (intake)

1. **Tools.** Any of these: an OpenAPI spec, an MCP server URL (we call `tools/list`), or OpenAI/Anthropic function JSON. Each tool becomes a `ToolSpec`.
2. **Data shape.** Postgres DDL or sample records. If they give neither, we infer tables from the tool schemas. An LLM writes **fake** seed data, which is validated by running it on a scratch branch. We never accept real customer data.
3. **Rules.** Help docs, policies and SOPs, split into numbered clauses (`PolicyDoc`) so every rubric item can cite a clause.
4. **Workflows.** For example: "process a refund", "reschedule an appointment", "update a CRM deal". We take these from their description or infer them from tools plus docs. Each workflow has invariants, such as "identity verified before any write".
5. **Optional production traces.** These are clustered to find real failure modes, which then seed scenarios.
6. **How we connect** (`IntegrationMode`):
   - **tool_loop** (default). Their agent is an OpenAI-compatible endpoint that returns `tool_calls`, and we run the loop. There is zero work on their side.
   - **sandbox_api.** Their agent runs its own loop. They point its tool base URL or MCP server at our per-run sandbox URL using a run token, which is a single env var change. This tests their real orchestration code.
   - **staging.** Their own staging stack. Tools pass through, and grading uses read-only checks they authorize. This is the most realistic option and needs the most trust.

## The sandbox (runtime)

- **One Neon branch per job** holds the world: DDL plus seed. **Each trial gets an isolated copy**, a child branch from the job branch. Neon branches are copy-on-write, so creating one is fast and cheap. We keep a pool of N trial branches and **reset each to its parent** between trials, which avoids branch-count limits. If the pool is exhausted, trials fall back to a per-trial Postgres schema.
- **Tool execution tiers:**
  1. `sql`: a deterministic binding (for example `POST /refunds` → `INSERT INTO refunds …`) with validated, named parameters. Generated at ingest and checked by dry-run.
  2. `simulated`: for tools with no clean state mapping (`send_email`, `search_kb`). An LLM returns output that matches the schema, conditioned on a state snapshot. Side effects are written to `sandbox_outbox` so graders can check them, for example "emailed the right customer, with no PII from other customers".
  3. `passthrough`: staging mode only, with SSRF-checked URLs and encrypted credentials.
- **Fault injection,** set per scenario: HTTP 500, timeout, empty or stale result, rate limit, and **injected instructions inside tool results** (indirect prompt injection with canaries). This is where real agents break.
- **Isolation and safety:**
  - Sandbox tools have no network egress.
  - The SQL role is limited to the run's branch.
  - Grader queries are SELECT-only with a statement timeout.
  - Budgets are capped per job and per trial.
  - Branch TTL plus a cleanup cron.

## Scenarios (engine)

- We generate scenarios from **workflows × policies × an edge-case taxonomy:** happy path, boundary values (an order exactly 31 days old), missing info, conflicting policy, adversarial user, tool failure, injection, multi-step, and ambiguity.
- Each scenario has:
  - a **persona** (goal, style, facts revealed only when asked, max turns), played by a simulated user over a real multi-turn conversation;
  - **fixtures:** scenario-specific rows such as the edge-case order;
  - **state assertions:** SQL that returns `ok`, for example "no refund row; escalation ticket exists; amount = 14.50";
  - **trajectory assertions:** `verify_identity` was called before `refund_order`; `delete_account` was never called; at most N calls;
  - **collateral-damage check:** any write outside `allowedWriteTables` fails the scenario;
  - **rubric items** that cite policy clauses.
- **Oracle validation (quality gate).** Before a scenario is used, a privileged reference agent with full knowledge must satisfy every assertion in the sandbox. If it can't, the scenario is broken and is regenerated or dropped. This keeps impossible or wrong tests out of the suite.
- **The customer can approve the suite** before the paid run. Track B already has approved-suite admission.

## Running and grading

- **k trials per scenario** (default 5). Variants include paraphrases, typos, a different language, irrelevant context, and persona temperament.
- We report the **pass rate with a 95% Wilson CI**, plus **pass^k (`reliable`)**: whether it passed every time. A refund agent that is right 80% of the time is a liability.
- Failures are confirmed by reproduction, clustered by root cause, and fixes are verified by re-running in the sandbox with no regressions (the existing fix loop, now against state).
- **Report:**
  - a reliability matrix by workflow and category;
  - the trajectory replay;
  - the **state diff** (what the agent changed);
  - policy citations;
  - cost and latency for each trial.

## Build plan

| Phase | What | Owner (v0) | Files |
|---|---|---|---|
| P0 | Contract + plan | orchestrator | `sandbox/spec.ts`, this doc |
| P1 | Ingest: OpenAPI / MCP / function JSON → ToolSpec + bindings; DDL/inference; seed generation + validation; policy clause splitting; reference env `acme-refunds` | worker: ingest | `packages/core/src/sandbox/ingest/**`, `data/envs/**` |
| P2 | Runtime: Neon branch pool + reset, SQL executor with param binding, simulated tools + outbox, faults, diff, read-only grader queries | worker: runtime | `packages/core/src/sandbox/runtime/**` |
| P3 | Engine: scenario generation + oracle validation, user simulator, tool-loop driver (mode B), graders, k-trial runner + Wilson CI | worker: engine | `packages/core/src/sandbox/engine/**` |
| P4 | App: intake (upload spec / MCP URL / DDL / docs), sandbox REST + MCP endpoint for mode A (per-run token), results UI (matrix, replay, diff) | worker: app (after P1–P3 interfaces land) | `apps/web/src/app/sandbox/**`, `apps/web/src/app/api/sandbox/**`, `apps/web/src/server/sandbox-*.ts` |
| P5 | Wire as a package `sandbox_eval` in the job workflow + pricing; end-to-end demo against 3 public models on `acme-refunds` | orchestrator | services wiring |

## Track B coordination

Track B has a calendar simulator (`packages/core/src/simulator/`) with Neon branches and graders, plus approved-suite admission. The v0 is built in `packages/core/src/sandbox/` so it doesn't touch Track B files. The proposal to Alex is that Track B adopts `sandbox-spec-v1` and owns the engine (P3) after the hackathon, and that the calendar simulator becomes one `EnvironmentSpec`. No message has been sent; the founder approves first.

## Risks

- **Neon branch limits and latency:** use the pool with reset. Concurrency is capped at 4 trials.
- **Bad generated SQL bindings or seeds:** they must execute on a scratch branch at ingest, otherwise the tool falls back to `simulated` with a warning in the report.
- **Generated assertions that are wrong:** handled by the oracle gate and by customer suite approval.
- **Cost:** 12 scenarios × 5 trials × ~10 turns is about 600 agent calls plus the simulator and judge. We estimate $1–4 per eval on haiku/sonnet-class models. Each trial and each job has its own cap.
- **Customer data:** fake seed data only. Staging mode requires explicit authorization and is read-only for grading.
