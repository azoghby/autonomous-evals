# Hiring Autonomous Evals over MCP

Autonomous Evals evaluates AI agents and their outputs. Your agent can hire it directly through a remote MCP server: pick a package, submit a trace or an endpoint, get a quote, pay through Stripe Checkout, and receive a report with findings and verified remediations.

## Endpoint

| Environment | URL |
|-------------|-----|
| Production  | `https://autonomous-evals.vercel.app/api/mcp/mcp` |
| Local dev   | `http://localhost:3100/api/mcp/mcp` |

Transport is Streamable HTTP, stateless. There is no SSE stream and no session to keep alive; every request stands alone.

## Authentication

Send an API key as a bearer token:

```
Authorization: Bearer ae_live_...
```

- Keys look like `ae_live_...`, or `ae_test_...` when the server runs in Stripe test mode.
- Create one in the web app at `/settings/keys` (sign in first), or `POST /api/keys` with `{"name": "my-agent"}` using a signed-in session.
- The full key is shown once. Only a hash is stored. Revoke with `DELETE /api/keys/{id}`.
- Missing, invalid, or revoked keys get `401`.
- Rate limit: 60 requests per 10 minutes per key. Over the limit returns `429` with a `Retry-After` header.

Every tool is scoped to the key's customer. A job owned by someone else looks exactly like a job that does not exist ("not found").

## Client configuration

Claude Code:

```bash
claude mcp add --transport http autonomous-evals \
  https://autonomous-evals.vercel.app/api/mcp/mcp \
  --header "Authorization: Bearer ae_live_..."
```

Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json` in a project) and most other clients use this shape:

```json
{
  "mcpServers": {
    "autonomous-evals": {
      "url": "https://autonomous-evals.vercel.app/api/mcp/mcp",
      "headers": { "Authorization": "Bearer ae_live_..." }
    }
  }
}
```

Stdio-only clients can bridge with `mcp-remote`:

```json
{
  "mcpServers": {
    "autonomous-evals": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://autonomous-evals.vercel.app/api/mcp/mcp",
        "--header", "Authorization: Bearer ae_live_..."
      ]
    }
  }
}
```

## Packages and prices

Your agent picks a package and a pricing mode, never an arbitrary price.

| `package` | Fixed price | Per-finding cap | Input |
|-----------|-------------|-----------------|-------|
| `trace_audit` | $5.00 | $15.00 | `trace` (string, up to 200 KB), optional `systemPrompt` |
| `text_eval` | $5.00 | $15.00 | `endpoint` |
| `workflow_eval` | $5.00 | $15.00 | `endpoint` |
| `version_comparison` | $10.00 | $30.00 | `mode` (`"text"` or `"workflow"`), `endpointA`, `endpointB` |

Two pricing modes, chosen when you call `accept_quote`:

- `fixed` (default): the flat price above, charged at checkout.
- `per_finding`: checkout only authorizes the cap on the card. At delivery we capture $3.00 per confirmed finding (never above the cap). If nothing is confirmed, the authorization is released and you pay nothing.

An `endpoint` object has: `url` (HTTPS only), `model`, optional `apiKey`, `systemPrompt` (default `""`), optional `referenceText`. Call `list_packages` for the live list; it is the source of truth.

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `list_packages` | none | Packages, prices, deliverables, required inputs, both pricing modes |
| `create_job` | `package`, one of `trace` / `endpoint` / `endpointA`+`endpointB`+`mode`, optional `notes`, `authorizedToTest: true`, `idempotencyKey` | `{ jobId, state, jobUrl, replayed }` |
| `get_job` | `jobId` | `state`, `nextAction`, latest quote with `pricingOptions`, pending clarification questions, payments, last 10 progress events, findings, remediations, `summary` |
| `answer_clarification` | `jobId`, `answer` | `{ ok, messageId }` |
| `accept_quote` | `jobId`, `quoteVersion`, optional `pricingMode` (`fixed` or `per_finding`) | `{ checkoutUrl, pricingMode, capCents, pricing }` (a real Stripe Checkout URL) |
| `get_report` | `jobId` | Summary, findings (with `id`, `findingKey`, truncated evidence), verified remediations, full report markdown |
| `rerun_finding` | `jobId`, `findingId` (a finding's `id`) | Re-check of one finding (job must be `delivered`, max 3 per finding) |
| `cancel_job` | `jobId`, optional `reason` | `{ ok }`. Only before work starts; closes any open checkout |

Also exposed over MCP:

| Kind | Name | What it is |
|------|------|------------|
| Resource | `autonomous-evals://sample-report` | A finished sample report (fictional agent) as markdown. Read it to see what you get for the price |
| Prompt | `sample_report` | Loads the sample report into the conversation |
| Prompt | `hire_eval` (`target`) | Step-by-step playbook for hiring an eval end to end |

`authorizedToTest` must be literally `true`; it is your attestation that you may test the target.

Job states: `draft`, `needs_clarification`, `quoted`, `awaiting_payment`, `planning`, `running`, `investigating`, `delivered`, `payment_review`, `paused_budget`, `failed`, `cancelled`.

## End-to-end flow

1. `list_packages` to confirm packages and input requirements.
2. `create_job` with your input and a fresh `idempotencyKey`. You get a `jobId`.
3. Poll `get_job` until the state leaves `draft`. If it is `needs_clarification`, read the pending questions and call `answer_clarification`. Keep polling.
4. When the state is `quoted`, review the quote (package, `priceCents`, scope, deliverables). Choose `fixed` or `per_finding` and call `accept_quote` with the `jobId`, the quote's `version` as `quoteVersion`, and `pricingMode`.
5. Pay. `accept_quote` returns a Stripe Checkout URL (`checkoutUrl`). A human, or an agent with a payment capability, completes it there. Card data is never accepted over MCP.
6. Poll `get_job` while the job moves through `planning`, `running`, `investigating`. Back off between polls (every 15 to 30 seconds is plenty) to stay inside the rate limit.
7. At `delivered`, call `get_report`. Optionally call `rerun_finding` (with the finding `id` from `get_report`) to re-check a specific finding after you apply a remediation.

Example request:

```json
{
  "package": "text_eval",
  "endpoint": {
    "url": "https://api.example.com/v1/chat/completions",
    "model": "my-model",
    "apiKey": "sk-...",
    "systemPrompt": "You are a support agent for Acme."
  },
  "notes": "Focus on refund-policy claims.",
  "authorizedToTest": true,
  "idempotencyKey": "acme-support-2026-11-07-a"
}
```

## curl example

```bash
export AE_KEY=ae_live_...
MCP=https://autonomous-evals.vercel.app/api/mcp/mcp
call() { curl -s "$MCP" -H "Authorization: Bearer $AE_KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -d "$1"; }

# list tools
call '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# prices and both pricing modes
call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_packages","arguments":{}}}'

# hire us
call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_job","arguments":{"package":"trace_audit","trace":"user: refund me\nassistant: Done, refunded.","authorizedToTest":true,"idempotencyKey":"demo-1"}}}'

# check on it, then accept the quote per finding
call '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_job","arguments":{"jobId":"<jobId>"}}}'
call '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"accept_quote","arguments":{"jobId":"<jobId>","quoteVersion":1,"pricingMode":"per_finding"}}}'

# sample report resource
call '{"jsonrpc":"2.0","id":6,"method":"resources/read","params":{"uri":"autonomous-evals://sample-report"}}'
```

Responses are Server-Sent-Event framed (`data: {...}`); the JSON-RPC result is in `result`, with tool output in `result.structuredContent`.

## Idempotency

`create_job` takes an `idempotencyKey`. Repeating a call with the same key returns the same job instead of creating a second one, so it is safe to retry after a timeout or a dropped connection. Use a new key for each distinct evaluation. Keys are scoped to your customer account.

## Reports

`get_report` returns the summary, findings, and remediations. Each finding has `id`, `title`, `status` (`confirmed`, `rubric_concern`, `inconclusive`), `severity`, `category`, `description`, and evidence with excerpts truncated for MCP. Each remediation names its `findingId` (which matches a finding's `findingKey`, not its `id`), a `patch`, a `rationale`, and a `verification` block with before and after pass counts. Artifact downloads (full markdown or HTML report) need a web session; over MCP, use the content the tool returns.

## Error handling

Failures come back as MCP tool errors with `isError: true` and a plain-language message, for example an unknown `package`, a missing `authorizedToTest`, an invalid `quoteVersion`, or a job that is not found. Read the message and correct the call; do not blindly retry. HTTP-level failures:

| Status | Meaning | Action |
|--------|---------|--------|
| 401 | Missing, invalid, or revoked key | Check the header; create a new key |
| 429 | Rate limit hit | Wait for `Retry-After`, then resume with slower polling |

If `accept_quote` is called before a quote exists, or with a stale `quoteVersion`, re-read the job with `get_job` and use the latest quote.

## Security notes

- An API key is a bearer secret. Keep it in a secret store, never in prompts, logs, or repos. Revoke it if exposed.
- Credentials you pass in `endpoint.apiKey` are encrypted at rest, never sent to agents or logs, and deleted after the job. Use a scoped, low-limit key for the target anyway.
- Only submit targets you are authorized to test. Evaluations send adversarial and edge-case inputs to the endpoint you provide.
- Payment always happens through Stripe Checkout. The MCP server never sees card details.
- Test keys (`ae_test_...`) work against Stripe test mode and should not be used for real purchases.

## Ready-made integrations

- Claude Code plugin (`/audit-my-agent`): [`integrations/claude-code-plugin`](../integrations/claude-code-plugin/README.md)
- Cursor MCP config and rule: [`integrations/cursor`](../integrations/cursor/README.md)
