# Approved Scout additive extension

Target owner parent: `2df678268926da50d0219889fd2190b7edb6f6e8`. This folder supplies only the approved two-file Scout differential. The canonical owner stager is responsible for authenticating the complete parent and composed candidate before this helper is used.

The patch, component, SVG, original preimage manifest, seven existing chat test/support files and eight-check Scout suite are copied byte-for-byte from immutable commit `28c5f8b`. `INPUTS.json` authenticates each copied payload. The prior parent rendering/type/build evidence at `a7851f848ecea7621b227cf71744f888985d9f7b` remains historical evidence, not a replacement source tree.

The final 3f composition's private chat still has the exact approved preimage `5edecb09d3d9c6b4f920d570af78c4f5b9b2ce99f55ced563a1764a2260c456b`. Consequently no patch adaptation or preimage relaxation is needed. `apply.mjs` deliberately replaces only the obsolete historical parent-metadata check with an explicit caller responsibility to authenticate the new full composition. It retains the exact original per-file preimages, patch path allowlist and postimages. `ORIGINAL-PREIMAGES.json` is unchanged. Any different chat input fails rather than overwriting newer behavior.

```sh
node docs/current-company-main-adoption/scout-extension/apply.mjs /absolute/composed-candidate
node tests/track-b/current-company-main-adoption/scout-extension/run.mjs /absolute/scout-appended-candidate /absolute/evidence
```

The runner tests an already-appended candidate and explicitly copies `scout-mark.tsx`; the 38 existing chat checks and 8 Scout checks remain unchanged. The runner emits all executed fixture/config hashes before strict TypeScript and jsdom tests. It uses existing offline dependencies via `CHAT_UI_NODE_MODULES`, defaulting to `/tmp/progress-chat-ui-verification/node_modules`.

The approved component remains decorative (`aria-hidden`, nonfocusable), static and `currentColor`, with a 32px header mark and 16px persisted-progress/answer marks. Existing heading, accessibility names, networking, authorization and revocation code remain unchanged. No browser screenshots, actual pixel layout, theme contrast, hosted authorization or deployment are claimed.

Local log, 2026-11-07: read ledger and global design standards; extracted approved immutable payloads; retained original hash boundaries; added a reproducible runner for the final candidate. Root ledger and Git are parent-owned.

Helper verification: strict types and all 46 checks passed against a temporary copy of the three exact final-3f chat/view/hook files plus the approved extension. Logs and all executed input hashes are in `tests/track-b/current-company-main-adoption/scout-extension/helper-verification/`. This validates the helper and the unchanged chat seam; the integrator must separately execute the final 2df candidate.
