# Standard Evals for Cursor

1. Copy `mcp.json` to `.cursor/mcp.json` (project) or merge it into `~/.cursor/mcp.json` (global). There is no API key: click **Connect / Login** next to `standard-evals` in Cursor, sign in with the emailed magic link, and approve.
2. Copy `audit-my-agent.mdc` to `.cursor/rules/audit-my-agent.mdc`.
3. In chat, ask: "Audit my agent with Standard Evals." (or `@audit-my-agent`).

Headless/CI fallback: create a key at https://autonomous-evals.vercel.app/settings/keys and add `"headers": { "Authorization": "Bearer ${env:STANDARD_EVALS_API_KEY}" }` to the server entry (Cursor expands `${env:NAME}`).

Same guardrails as the Claude Code plugin: redact and confirm before upload, the human pays at the Stripe link, patches applied only with approval.
