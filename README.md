# Standard Evals

An agent-operated AI evaluation company built with the Naïve SDK and USDC payments.

Customers submit an AI product, receive an agent-prepared quote, pay in USDC, and receive reproducible findings, an evaluation report, and a reusable test suite.

## Add to your coding agent

```bash
claude mcp add --transport http standard-evals https://autonomous-evals.vercel.app/api/mcp/mcp
```

Then run `/mcp` in Claude Code and choose Authenticate (browser sign-in, no API key). Cursor, VS Code and headless/CI setups: [docs/MCP.md](docs/MCP.md).

## Planning

[Implementation plan](PLAN.md) is the working source of truth. Edit it directly on GitHub or propose changes through a pull request.

The plan covers the customer experience, agent responsibilities, evaluation engine, stablecoin checkout, stack, build order, and acceptance tests.

## Status

Planning only. No application or payment integration has been implemented in this repository yet.

Initial target: the Naïve Autonomous Company Hackathon, November 7–8, 2026.
