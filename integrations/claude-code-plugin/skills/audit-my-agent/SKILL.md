---
name: audit-my-agent
description: Hire Standard Evals to audit the AI agent in this repo. Finds the agent's system prompt or a recent trace, uploads a redacted copy (after confirmation), gets a quote, hands the human the payment link, then summarizes findings and verified fixes and offers to apply the patches. Use when the user runs /audit-my-agent or asks to audit, eval, red-team, or test their agent.
argument-hint: "[optional path to prompt or trace file]"
---

# Audit my agent with Standard Evals

You hire Standard Evals through its MCP tools (`list_packages`, `create_job`, `get_job`, `answer_clarification`, `accept_quote`, `get_report`, `rerun_finding`, `cancel_job`). The tool names may appear prefixed, e.g. `mcp__standard-evals__create_job`.

## Hard rules

1. Never pay without an explicit human OK in this conversation. `accept_quote` only returns a link or payment instructions; show the checkout URL and let the human pay. Never sign or send an x402 payment yourself.
2. Never upload anything before the human has seen exactly what will be sent (after redaction) and said yes.
3. Never include secrets: `.env*` content, API keys, tokens, passwords, private keys, cookies, connection strings, customer PII. Redact first (see below).
4. Do not retry failed tool calls blindly. Read the error message and correct the call. On 429, wait for Retry-After and poll slower.
5. Do not apply patches to files without showing them and getting a yes.

## Step 0: Check setup

If the Standard Evals tools are unavailable or return 401, tell the user: create a key at https://autonomous-evals.vercel.app/settings/keys, then `export STANDARD_EVALS_API_KEY=ae_...` in the shell that launches Claude Code, and restart Claude Code. Stop there.

## Step 1: Find the target

If the user gave a path ($ARGUMENTS), use it. Otherwise search the repo (skip node_modules, .git, build output, `.env*`):

- System prompts: `**/system_prompt*`, `**/prompts/**`, `**/*.prompt`, `**/*.prompt.md`, `AGENTS.md`/`CLAUDE.md` of the product agent (not this tooling), and string constants such as `system:`, `systemPrompt`, `SYSTEM_PROMPT`, `role: "system"` in source.
- Traces: `**/traces/**`, `**/*.jsonl`, `**/logs/**`, `**/runs/**`, `**/transcripts/**`, LangSmith/Langfuse/OpenTelemetry exports, `trace*.json`.

If several candidates exist or none is clearly the agent, list at most 5 and ask which to use. Prefer a trace (package `trace_audit`) when one exists; it accepts a `trace` string up to 200 KB plus an optional `systemPrompt`. If only a prompt exists, send it as `systemPrompt` with a short trace that you ask the user to supply, or ask whether they have a live HTTPS endpoint for `text_eval`/`workflow_eval` instead. Do not fabricate a trace.

## Step 2: Redact and confirm

1. Build the payload text. Truncate to under 200 KB, keeping the most recent turns.
2. Scan for and replace with `[REDACTED:<kind>]`: strings matching `sk-`, `ae_live_`, `ae_test_`, `ghp_`, `xox[bap]-`, `AKIA[0-9A-Z]{16}`, `eyJ` JWTs, `-----BEGIN ... PRIVATE KEY-----`, `Bearer <token>`, `password|secret|token|api[_-]?key` assignments, URLs with embedded credentials, emails and phone numbers of real people, and anything lifted from a `.env` file. Prefer a scripted pass (e.g. a short `grep -nE` / `sed` run) in addition to reading it yourself.
3. Show the human: source file path(s), byte size, a count of redactions by kind, and the redacted content (or its first and last ~40 lines if long). Ask: "Upload this to Standard Evals? (yes/no)". Also tell them you will set `authorizedToTest: true`, which attests they are allowed to test this agent. Wait for yes.

## Step 3: Pick a package

Call `list_packages`. It is the source of truth for prices and inputs. Recommend one with a one-line reason:
- `trace_audit`: you have a trace (cheapest, no live endpoint needed).
- `text_eval` / `workflow_eval`: the human has a live HTTPS endpoint (never put real credentials in chat; only use a scoped, low-limit key they explicitly provide).
- `version_comparison`: they are choosing between two prompt/model versions.
State fixed price vs. per-finding cap. Get the human's pick if it is not obvious.

## Step 4: Create the job

Call `create_job` with `package`, the input, `notes` (what the agent does and what the human worries about), `authorizedToTest: true`, and an `idempotencyKey` like `<repo-name>-<package>-<YYYYMMDD>-<short random>`. Keep the key and reuse it if you must retry the same request. Report the `jobId` and `jobUrl`.

## Step 5: Clarifications

Poll `get_job` every 15 to 30 seconds. If `state` is `needs_clarification`, show the pending questions to the human, answer from repo knowledge only when you are certain and non-secret; otherwise ask the human. Send via `answer_clarification`. Keep polling.

## Step 6: Quote and payment

When `state` is `quoted`, show package, `priceCents`, scope, deliverables, and `pricingOptions`. Default to `fixed` price; mention `per_finding` only as the alternative (card authorizes the cap, captured at about $3 per confirmed finding). Ask the human which to use and for an explicit "yes, proceed to payment".

Only then call `accept_quote` with `jobId`, `quoteVersion` (the quote's `version`) and `pricingMode`. If it errors on a stale version, re-read with `get_job` and use the latest quote, and re-confirm if the price changed.

Show the `checkoutUrl` prominently and tell the human to open it and pay. If the result includes a `payWithX402` block (test jobs only), mention it exists but do not execute it unless the human explicitly instructs you to and supplies the wallet tooling. Then wait for the human to say they paid, or just poll.

If the human declines or abandons, offer `cancel_job` (allowed only before work starts).

## Step 7: Wait

Poll `get_job` every 15 to 30 seconds (limit is 60 requests per 10 minutes per key). Give a one-line status update when the state changes (`planning`, `running`, `investigating`). Stop at `delivered`. If the state is `failed`, `payment_review`, `paused_budget`, or `cancelled`, surface `summary`/`nextAction` and ask the human what to do.

## Step 8: Report

Call `get_report`. Summarize for the human:
- Headline: counts by severity and status (`confirmed`, `rubric_concern`, `inconclusive`). Put `confirmed` first; flag `rubric_concern`/`inconclusive` as lower confidence.
- For each finding: title, severity, one-sentence description, one evidence excerpt.
- For each remediation: which finding it fixes (match `remediation.findingId` to a finding's `findingKey`, not its `id`), a short rationale, and the verification result (before vs. after pass counts).

Present verified fixes as proposals, not facts about your own code.

## Step 9: Apply patches

Offer to apply the remediation patches locally. For each, map the patch to the real file (the prompt file or code constant found in Step 1), show the diff, and apply only after a yes. After applying, offer `rerun_finding` with the finding `id` (not `findingKey`) to re-check it (job must be `delivered`, max 3 per finding). Do not commit unless asked.
