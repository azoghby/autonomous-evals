# Agent instructions (Codex / Claude / any coding agent)

Start by reading LEDGER.md — it is the source of truth for what is done, in flight, and next.
After every meaningful change: update LEDGER.md (move items, append to Log), run `npx tsc -p apps/web --noEmit` and `npm test`, then commit to `track-a`.
Next.js here is 16.4 with breaking changes — read node_modules/next/dist/docs before using unfamiliar APIs. Workflow DevKit docs: node_modules/workflow/docs.
Never set AUTH_DEV_LINKS=1 in production. Never commit .env files. Track B directories are off-limits (see TRACKS.md).
