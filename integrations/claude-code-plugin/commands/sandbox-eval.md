---
description: Build a sandbox copy of this repo's agent world and evaluate the agent inside it (Standard Evals sandbox evals)
argument-hint: "[optional agent endpoint URL]"
---

Run a Standard Evals sandbox eval for the agent in this repo. Hint from the user: $ARGUMENTS

Rules: never send secrets (`.env*`, API keys, tokens, passwords, connection strings, real customer data). Send file CONTENTS, not paths. Do not upload anything until the user has seen what you will send and said yes. If a tool call fails, read the error and fix the call; do not blindly retry.

If the `sandbox_*` tools are missing or return 401, tell the user to run `/mcp`, select `standard-evals`, and choose Authenticate, then stop.

## 1. Find the spec files

Search the repo (skip node_modules, .git, build output, `.env*`) for:
- API spec: `openapi.yaml`, `openapi.yml`, `openapi.json`, `swagger.*` -> `openapi`
- Tool/function definitions: `tools.ts`, `*.tools.json`, OpenAI-style function schemas, or your MCP server's tool list -> `functions` / `mcpTools`
- DB schema: `*.sql`, `migrations/`, `prisma/schema.prisma`, Drizzle schema. Convert to Postgres DDL -> `ddl`
- Seed data: `seed.sql`, `seeds/`, fixtures. Fake data only; if only real data exists, write a small fake seed instead -> `seedSql`
- Policies: `docs/policies/*.md`, `POLICY*.md`, support playbooks, refund/returns/escalation rules -> `policies` (markdown strings or `{title, markdown}`)

At least one of OpenAPI, functions or MCP tools is required. If none exists, tell the user what is missing and offer to draft tool definitions from the code. List what you found (paths, sizes) and ask which to include.

## 2. Ask for the agent under test

Ask the user for: the agent's HTTPS endpoint (an OpenAI-compatible chat completions URL that returns tool_calls), the model name, and, only if it needs auth, the NAME of a stored credential (`apiKeyRef`). Never ask for or send the secret itself.

## 3. Create the environment

Read the chosen files, show the user a summary (file names, sizes, anything redacted), get a yes, then call `sandbox_create_environment` with their contents.

## 4. Generate and confirm the suite

Call `sandbox_generate_suite` with the `environmentId`. Show the scenario preview and ask the user to approve or request changes. Do not run without approval.

## 5. Run

Call `sandbox_run` with `environmentId`, `suiteId` and `k` (default 5; 1-10). Then poll `sandbox_status` every 15-30 seconds until complete or failed.

## 6. Report

Call `sandbox_report`. Summarize pass rates and pass^k per workflow, the worst failures (policy clause violated, state diff), and proposed fixes. Show any patch as a diff and apply it only with the user's OK. Nothing is committed.

## If the result is `coming_soon`

If any tool returns `status: "coming_soon"`, the sandbox engine is not live yet. Tell the user exactly that: nothing was created or run, no environment, suite or run id exists, and there are no results. Do not invent ids, scenarios or scores, and do not poll. Offer `/audit-my-agent` as the available alternative and suggest trying again later.
