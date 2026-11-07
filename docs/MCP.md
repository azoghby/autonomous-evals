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

JSON config (Cursor and most other clients use the same shape):

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

Prices are fixed. Your agent picks a package, never a price.

| `package` | Price | Input |
|-----------|-------|-------|
| `trace_audit` | $5.00 | `trace` (string, up to 200 KB), optional `systemPrompt` |
| `text_eval` | $5.00 | `endpoint` |
| `workflow_eval` | $5.00 | `endpoint` |
| `version_comparison` | $10.00 | `mode` (`"text"` or `"workflow"`), `endpointA`, `endpointB` |

An `endpoint` object has: `url` (HTTPS only), `model`, optional `apiKey`, `systemPrompt` (default `""`), optional `referenceText`. Call `list_services` for the live list, since it is the source of truth for prices and deliverables.

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `list_services` | none | Packages, prices, deliverables, input requirements |
| `request_eval` | `package`, one of `trace` / `endpoint` / `endpointA`+`endpointB`+`mode`, optional `notes`, `authorizedToTest: true`, `idempotencyKey` | `{ jobId, state, jobUrl }` |
| `get_job` | `jobId` | `state`, latest quote, pending clarification questions, last 10 progress events |
| `answer_clarification` | `jobId`, `answer` | Updated job state |
| `accept_quote` | `jobId`, `quoteVersion` | A Stripe Checkout URL (currently the job page URL, where the owner accepts and pays) |
| `get_report` | `jobId` | Summary, findings (evidence truncated), remediations, download note |
| `rerun_finding` | `jobId`, `findingId` | Re-check of one finding |

`authorizedToTest` must be literally `true`; it is your attestation that you may test the target.

Job states: `draft`, `needs_clarification`, `quoted`, `awaiting_payment`, `planning`, `running`, `investigating`, `delivered`, `payment_review`, `paused_budget`, `failed`, `cancelled`.

## End-to-end flow

1. `list_services` to confirm packages and input requirements.
2. `request_eval` with your input and a fresh `idempotencyKey`. You get a `jobId`.
3. Poll `get_job` until the state leaves `draft`. If it is `needs_clarification`, read the pending questions and call `answer_clarification`. Keep polling.
4. When the state is `quoted`, review the quote (package, `priceCents`, scope, deliverables). Call `accept_quote` with the `jobId` and the quote's `version` as `quoteVersion`.
5. Pay. `accept_quote` returns a Stripe Checkout URL. A human, or an agent with a payment capability, completes it there. Card data is never accepted over MCP.
6. Poll `get_job` while the job moves through `planning`, `running`, `investigating`. Back off between polls (every 15 to 30 seconds is plenty) to stay inside the rate limit.
7. At `delivered`, call `get_report`. Optionally call `rerun_finding` to re-check a specific finding after you apply a remediation.

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

## Idempotency

`request_eval` takes an `idempotencyKey`. Repeating a call with the same key returns the same job instead of creating a second one, so it is safe to retry after a timeout or a dropped connection. Use a new key for each distinct evaluation. Keys are scoped to your customer account.

## Reports

`get_report` returns the summary, findings, and remediations. Each finding has `id`, `title`, `status` (`confirmed`, `rubric_concern`, `inconclusive`), `severity`, `category`, `description`, and evidence with excerpts truncated for MCP. Each remediation names its `findingId`, a `patch`, a `rationale`, and a `verification` block with before and after pass counts. Artifact downloads (full markdown or HTML report) need a web session; over MCP, use the content the tool returns.

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
