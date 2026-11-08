# Standard Evals for Claude Code

Type `/audit-my-agent` and Claude hires Standard Evals to audit your agent: it finds your system prompt or a recent trace, redacts secrets, asks you before uploading, gets a quote, gives you the checkout link, and then summarizes the findings and verified fixes and offers to apply the patches.

## 1. Sign in (no API key)

After installing, run `/mcp` in Claude Code, select `standard-evals`, and choose **Authenticate**. Your browser opens: sign in with an email magic link and approve access. That is the whole setup.

Headless/CI fallback: create a key at `/settings/keys` and use `claude mcp add --transport http standard-evals https://autonomous-evals.vercel.app/api/mcp/mcp --header "Authorization: Bearer ae_live_..."` instead of the plugin's bundled server entry.

## 2. Install

Local path (try it without publishing):

```bash
claude --plugin-dir /path/to/autonomous-evals/integrations/claude-code-plugin
```

From a marketplace (once this directory is published in one, e.g. a git repo with `.claude-plugin/marketplace.json` listing `standard-evals`):

```bash
/plugin install standard-evals --marketplace azoghby/standard-evals
```

Run `claude plugin --help` for the commands your CLI version supports. Validate the plugin with `claude plugin validate integrations/claude-code-plugin`.

## 3. Use

```
/audit-my-agent
/audit-my-agent path/to/prompt-or-trace
/sandbox-eval
```

`/sandbox-eval` reads your OpenAPI spec, tool definitions, DB schema, seed data and policy docs from the repo, builds a sandbox copy of your agent's world, generates a test suite for you to approve, runs it, and reports. The sandbox engine is rolling out; until it is live the tools answer `coming_soon` and the command says so.

Check `/mcp` shows `standard-evals` as connected. If it shows "needs authentication", choose Authenticate in `/mcp`.

## Guardrails

- Nothing is uploaded until you see the redacted payload and say yes.
- Secrets and `.env` content are scanned for and redacted first.
- Claude never pays. `accept_quote` returns a Stripe Checkout URL that you open yourself.
- Patches are shown as diffs and applied only with your OK. Nothing is committed.

## Layout

```
.claude-plugin/plugin.json     manifest
.mcp.json                      HTTP MCP server (OAuth, no key)
skills/audit-my-agent/SKILL.md the workflow
commands/audit-my-agent.md     /audit-my-agent entry point
commands/sandbox-eval.md       /sandbox-eval entry point
```

Tool reference: `docs/MCP.md`.
