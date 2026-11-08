# Pixel Scout mark in the private progress chat

Owner-applyable, additive artifact. No Track A app, platform, manifest or historical patch bytes are changed here, and nothing is mounted live. Applying `integration/owner.patch` is the owner's decision.

## Artwork (approved, not redesigned)

`assets/brand/scout-pixel.svg` is the user-approved pixelated Scout bunny verbatim: 16x16 grid, folded right ear, squared face, `currentColor`, `shape-rendering="crispEdges"`. SHA-256 of the file (with trailing newline): `dbcc61e36930cd25472a308564f26e96219aa4e7bec9805e3c4d441e27f55302`. The tests pin the exact string, so any redraw fails.

## Component

`component/scout-mark.tsx` exports `ScoutMark({ size?: 16 | 32, className? })` and `SCOUT_PIXEL_PATH`. It renders the same single path, with `aria-hidden="true"` and `focusable="false"`. It has no animation, no raster, no remote font and no dependency beyond React's JSX runtime. Only 16px (1x) and 32px (2x) are allowed so grid cells land on whole device pixels. The color comes from the parent through `currentColor`.

## Chat change (`integration/owner.patch`)

Target: `apps/web/src/components/app/job-private-chat.tsx` in the composed candidate (`CURRENT-COMPOSITION.json` parent `039851736eabb94e85c2c111bbccc78374716275`, not baseline). The patch also creates `apps/web/src/components/app/scout-mark.tsx`, byte-identical to `component/scout-mark.tsx`.

| File | Pre-image SHA-256 | Post-image SHA-256 |
| --- | --- | --- |
| `apps/web/src/components/app/job-private-chat.tsx` | `5edecb09d3d9c6b4f920d570af78c4f5b9b2ce99f55ced563a1764a2260c456b` | `fd4d2fcc8a1fadebc52089ca72c3f58fa1dc81d8ecc7ea4e91861f83d3cee9b4` |
| `apps/web/src/components/app/scout-mark.tsx` | (new file) | `9ca44107662d2e1b4e5f644b023207f3cb531d7e34a6f7f778627b348fc8f435` |

Changes:

- Header: a 32px mark in `text-accent-text` (blue) sits beside a wrapper holding the unchanged `<h2>Private progress chat</h2>` and description. `aria-labelledby` still resolves to the same heading.
- "Latest persisted progress" and "Answer N" labels each gain a 16px mark in `text-fg` (white) inside the existing label element. Their text nodes are unchanged.
- No Scout text label was added, so no accessible heading or name changes. All fetch, polling, replay, revocation and authority code is untouched.

## Owner application requirements

1. Apply to a writable copy of the exact composed candidate: `node docs/pixel-scout-chat/integration/apply.mjs <stage>`. It refuses baseline candidates, wrong parents, preimage drift and result drift, and creates no commit.
2. Applying changes the hash of `job-private-chat.tsx`. Provenance records that pin `5edecb09...` (for example `CURRENT-COMPOSITION.json`, `docs/track-b-final-composition/INTEGRITY.json`, `docs/chat-workflow-release/SHA256SUMS` and build evidence) will need regeneration by whoever owns those. This artifact does not touch them.
3. The mount harness `tests/track-b/current-chat-mount/ui/run.mjs` copies a fixed file list and does not copy `scout-mark.tsx`. Against a patched stage use `tests/track-b/pixel-scout-chat/run.mjs`, which runs those suites unmodified.
4. After applying, run the repo's own `npx tsc -p apps/web --noEmit` and `npm test` in the owner checkout. A production build and a browser look were not performed here.

## Verification performed (offline, `evidence/`)

`node tests/track-b/pixel-scout-chat/run.mjs /private/tmp/track-b-company-composed-y74pmmb8 docs/pixel-scout-chat/evidence` copies the candidate files into a temp stage (the candidate is not written), applies the patch with hash checks, then runs strict `tsc` and vitest/jsdom: the 38 existing current-chat-mount checks unmodified plus 8 new Scout checks, 46 passing. The new checks cover the exact artwork, a single path, 16/32 sizes, `aria-hidden`, no tab stops, preserved heading, region and list names, and no animation, remote, raster or hard-coded colors.

A separate full-app `tsc -p apps/web --noEmit` on a copy of the candidate with the patch applied reports exactly two errors, and the unpatched candidate copy reports the same two: missing `@vercel/analytics/next` types and `LayoutProps` in `layout.tsx`. This is an environment gap (missing local dependency and generated Next types), not caused by this change.

Not verified: browser rendering, screenshots, actual pixel crispness, contrast measurement in the real theme, production build, live mounting.
