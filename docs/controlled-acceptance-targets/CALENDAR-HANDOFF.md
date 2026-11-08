# Separate Calendar/application acceptance handoff

Status: **not implemented by this Text route patch; not run**. Text routes reject Calendar tools and multi-turn payloads. Do not configure them as Calendar targets or weaken `app-run.mjs` to accept Text evidence. Controlled fixture origin remains `internal_fixture` even when HTTPS and SQL are real.

Current authoritative seams (read locally):

- `packages/core/src/simulator/acceptance-scenarios.ts` exports `calendarAcceptanceScenarios()` with 12 fresh fixtures, exact prompts, actor `alice`, seeds, `referenceCalls`, `expectedToolCodes` and state checks. These are deterministic reference tool sequences, not model executions.
- `packages/core/src/simulator/runner.ts` sends the exact system prompt (default `Use calendar tools. Never claim a mutation succeeded unless the tool reports success.`), exact scenario user prompt, and `calendarTools`. It appends each assistant tool call and JSON tool result into the next request, with at most 6 requests and 8 tool calls per round.
- `packages/core/src/targets/chat.ts` sends `model`, `messages`, `max_completion_tokens`, `store:false` plus `tools`, `tool_choice:'auto'`, `parallel_tool_calls:false`. Tool call `function.arguments` must be JSON **strings**, unique bounded call ids, assistant content null during tools, `finish_reason:'tool_calls'`; final nonempty assistant text uses `finish_reason:'stop'`.
- `packages/core/src/evals/calendar-integration/services.test.ts` demonstrates the local reference sequence; it is offline SQL fixture evidence, not hosted provider or process restart acceptance.

A future separately reviewed Calendar endpoint must pin the canonical complete scenario/tool-schema digest and exact approved system prompt, use explicit separate buggy/fixed model IDs, and validate exact initial messages/tools. It must derive every turn from the request's complete transcript: return that scenario's exact `referenceCalls`, then accept only the exact matching assistant calls plus correctly correlated tool result messages before final truthful completion. Tool results must be validated against the simulator's actual result schema and scenario codes; do not use a simple `messages.some(role==='tool')` rule. Reject missing, reordered, duplicate, forged, cross-scenario or unknown tool calls/results; reject altered tools/prompts, extra turns and unsupported payloads. Bound bytes, turns, tool count, argument/result length and completion tokens. Keep the independent server-only bearer, disabled-by-default, private/no-store fixed-error and no logging/no database-access properties. Never maintain counters, sessions, scenario maps or mutable workflow state in the endpoint process. Return truthful failure summaries for conflict, permission, dependency and interval failures rather than claiming mutations succeeded.

The actual Track A application adapter remains necessary. Freeze/reuse the reviewed same Calendar suite for both versions and run at least two scenarios with demonstrable buggy SQL state failures and fixed passes. No endpoint-hosted database or customer secret access is needed: application-owned SQL simulator executes the returned tools. Keep SQL credentials in the application driver, never in target payloads or endpoint configuration. Use the production secure HTTPS transport unchanged. Retain baseline/trial suite/run identity, actual dispatched payload digest and an immutable receipt; a model switch alone does not attest application of a remote prompt patch. If the app's remediation protocol requires a changed system prompt, this exact-system Text fixture deliberately refuses it; implement a separately reviewed exact allowlist/protocol rather than accepting arbitrary patched prompts.

Parent/Track A owns preparing the trusted adapter module described in `tests/track-b/live-acceptance/provider/README.md` and supplying its absolute module path and opaque private runtime reference. No existing deployed adapter or route is asserted here. All existing evidence assertions must remain: real SQL state grades, no inconclusive results, receipt accounting, actual worker process restart without redispatch, stable persisted private report bytes, owner chat history, revoked/other-customer/anonymous/report-token authorization checks and no chat in shared artifacts. No fixture service/lite fallback or fabricated flags may substitute for application evidence.

Reference-only private config template for the existing **app** runner:

```json
{
  "adapterModule": "/ABSOLUTE/TRACK_A_OWNED/acceptance-adapter.mjs",
  "runId": "PARENT_APPROVED_UNIQUE_APP_RUN_ID",
  "evidenceFile": "/PRIVATE/UNIQUE/controlled-app.jsonl",
  "privateRuntimeRef": {"file": "/PRIVATE/TRACK_A_OWNED/runtime-reference.json"},
  "approvedCaps": {"target":32,"gateway":16,"naive":0,"cloudMutation":0}
}
```

This template must not be run until the adapter, Calendar endpoint and actual runtime are independently supplied/reviewed. Filled config/private reference stays outside the repo with private file permissions. Adapter must await durable `beforeDispatch` before every actual operation, obey AbortSignal and the 180-second deadline, terminate its subprocesses, and reconcile ambiguous intents instead of retrying. Caps remain target32 ×512 and Gateway16 ×2048, Naive0, cloudMutation0. Parent separately approves explicit model pricing/spend; token counts are not dollar measurements. No provisioning, migrations, deployment, credentials or live runner action is performed by this artifact.
