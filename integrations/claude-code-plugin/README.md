# Standard Evals for Claude Code

Type `/audit-my-agent` and Claude hires Standard Evals to audit your agent: it finds your system prompt or a recent trace, redacts secrets, asks you before uploading, gets a quote, gives you the checkout link, and then summarizes the findings and verified fixes and offers to apply the patches.

## 1. Get an API key

Sign in at https://autonomous-evals.vercel.app and create a key at `/settings/keys`. The key is shown once. Then:

```bash
export STANDARD_EVALS_API_KEY=ae_live_...   # ae_test_... against Stripe test mode
```

Put that in your shell profile so it is set when Claude Code starts. Never commit it.

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
```

Check `/mcp` shows `standard-evals` as connected. A 401 means the key is missing or wrong in the environment Claude Code was launched from.

## Guardrails

- Nothing is uploaded until you see the redacted payload and say yes.
- Secrets and `.env` content are scanned for and redacted first.
- Claude never pays. `accept_quote` returns a Stripe Checkout URL that you open yourself.
- Patches are shown as diffs and applied only with your OK. Nothing is committed.

## Layout

```
.claude-plugin/plugin.json     manifest
.mcp.json                      HTTP MCP server, Authorization: Bearer ${STANDARD_EVALS_API_KEY}
skills/audit-my-agent/SKILL.md the workflow
commands/audit-my-agent.md     /audit-my-agent entry point
```

Tool reference: `docs/MCP.md`.
