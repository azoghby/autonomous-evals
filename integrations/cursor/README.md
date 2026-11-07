# Standard Evals for Cursor

1. Create an API key at https://autonomous-evals.vercel.app/settings/keys and export it before launching Cursor:
   `export STANDARD_EVALS_API_KEY=ae_live_...`
2. Copy `mcp.json` to `.cursor/mcp.json` (project) or merge it into `~/.cursor/mcp.json` (global). Cursor expands `${env:NAME}` in `headers`.
3. Copy `audit-my-agent.mdc` to `.cursor/rules/audit-my-agent.mdc`.
4. In chat, ask: "Audit my agent with Standard Evals." (or `@audit-my-agent`).

Same guardrails as the Claude Code plugin: redact and confirm before upload, the human pays at the Stripe link, patches applied only with approval.
