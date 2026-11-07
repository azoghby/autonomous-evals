# Design v4: Precision Black

Reference: neon.com (home, /pricing, /docs), captured 2026-11-07 at 1440 and 390 wide.
We borrow its **design language only**. No copy, logos, imagery or assets.
Our identity stays: black / white / **electric blue**, ribbed cursor-reactive hero lines (RibField),
headline bottom-left, CTA bottom-right, feature row along the bottom.

---

## 1. What makes Neon feel precise (measured)

| Trait | Neon (computed) | Why it reads as "precise" |
|---|---|---|
| Display weight | h1 56px **400**, h2 44px **400**, h3 16px 400 | Regular weight at display size + tight tracking = engineered, not shouty. Our v3 used bold/medium: looked heavy and blobby. |
| Tracking | -0.04em on h1/h2 (-2.24px @56), -0.02em on 15–24px body | One tracking rule scaled by size. No wide-spaced caps. |
| Line height | h1 1.12, h2 1.125, body 24/16 | Tight display, normal body. |
| Two-tone headings | "Ready for coding agents. *Create and branch…*" white lead + gray (#94979E) continuation | Hierarchy inside one sentence; removes need for separate subhead. |
| Mono eyebrows | GeistMono 12px UPPERCASE, **normal tracking**, preceded by a small coloured ▶ marker | Labels look like system output, not decoration. v3's `tracking-[0.3em]` caps ("R E P O R T") looked dated. |
| Giant index numerals | "01", "02" mono 128px, tracking -0.04em, colour #303236 (barely visible) | Structure + rhythm without boxes. |
| Hairlines | 1px #242628 (dense grids), #303236, #494B50 (interactive outlines); dashed rows in pricing | Grid is drawn by borders, not cards. |
| Radius | 4px almost everywhere (120 uses); pill only on nav buttons | Sharp, consistent. |
| Containers | 1600 max with 32px gutters; section text column 1280/1024/856 | Everything aligns to the same left edge as the logo. |
| Layout | 12-col: left rail (~350px) holds eyebrow + numeral; content starts at col 4–5 | Asymmetric, editorial, dense but aligned. |
| Section rhythm | 96–128px vertical padding; alternating near-black (#18191B) / black bands | Clear chapters. |
| Product visuals | Real UI fragments (terminal lines, forms, branch graphs) in 4px-radius hairline frames, mono 12px | Shows the product instead of describing it. |
| Pricing | 3 columns in one bordered grid, mono uppercase plan name, big price, square bullets, dashed section dividers | Table-like, scannable. |
| Glow | Only in hero art; everything else flat | Restraint makes the hero land. |
| Nav | 64px, sticky, black, links 15px white, outline "Log in" + filled "Sign up" | Quiet chrome. |
| Mobile | Same type system scaled (h1 ~36px), 20px gutters, everything single column, numerals ~72px | Not a separate design. |

## 2. What was sloppy in v3 (audit of before-*.png)

1. **Misaligned edges.** Hero content starts at x=32 (full-bleed) but every landing section and every app page sits in an 850–960px centred column (x≈144/240). Topbar is full-bleed on app pages, content is centred: two left edges on every screen.
2. **Wide-tracked mono eyebrows** ("H O W  I T  W O R K S", "R E P O R T  S U M M A R Y") read as decoration and are hard to scan.
3. **Weak hierarchy on landing.** How-it-works is four thin rows; pricing is a plain list with oversized blue prices; CTAs stranded small at section bottom-left; one product visual on the whole page.
4. **Hero feature row**: two-line mono pairs, first item randomly blue, cramped at 390 (5th item orphaned).
5. **Heavy headlines** on app/experts pages (semi-bold + -0.05em tracking → letters touch: "Get paid to review").
6. **Inconsistent controls**: expert form inputs 48px, operator inputs 40px, buttons 36/40/56 tall; outline vs filled used arbitrarily; "Home ↗" + "Dashboard" + "My jobs" duplicate nav.
7. **Status chips float far right** (job header), disconnected from the title they qualify.
8. **Operator**: KPI numbers unframed, sparse 5-column payments table with huge gaps, repeated "not counted" noise, form dumped at the bottom with no section frame.
9. **Report links** ("Report (.md) Suite (JSON) Evidence") are underlined text in a row: look unfinished.
10. **Reveal-gated content** renders as blank bands until scrolled (full-page captures and slow hydration show empty sections).
11. **Mobile**: topbar shows both "Get an eval" and hamburger crammed; feature row wraps into an orphan.

## 3. Our tokens (v4)

### Colour
```
--bg:            #000000   page
--bg-band:       #0B0C0E   alternating section band / sunken panels
--bg-raised:     #111214   panels, inputs, code blocks
--bg-hover:      #17181B
--fg:            #FFFFFF
--fg-2:          #C9CBCF   secondary text (long-form body on black)
--muted:         #94979E   two-tone heading continuation, descriptions   (7.0:1 on black)
--subtle:        #797D86   meta, captions                                 (4.9:1 on black, 4.6:1 on #111214)
--faint:         #303236   giant numerals, disabled (decorative only)
--line:          #1F2023   hairline (dense grids, table rows)
--line-2:        #2A2C30   panel borders, section dividers
--line-3:        #45484E   interactive outline (buttons, inputs), hover borders
--accent:        #2A5FFF   electric blue — filled CTA (white text 5.0:1), active marks, focus ring
--accent-hover:  #3D6EFF
--accent-text:   #6B97FF   blue text/links on black (7.3:1)
--accent-soft:   rgb(42 95 255 / 0.12)  selected row / highlight wash
--ok #3DD68C  --warn #F5B84B  --danger #FF6B5E  (status dots + text only)
```
Rules: blue is used for (a) the one primary CTA per view, (b) eyebrow ▶ markers, (c) active/selected state, (d) focus ring, (e) live dots, (f) highlighted words in mono code. Never for large price numbers or decorative fills.

### Type (next/font only)
- **Sans: Geist** (precise neo-grotesk, excellent at 400 with negative tracking). Weights 400 / 500.
- **Mono: Geist Mono** (eyebrows, numbers, code, terminal blocks, table numerics). Weights 400 / 500.

| Token | Size / line-height / tracking | Use |
|---|---|---|
| display | clamp(48px, 8.4vw, 128px) / 0.96 / -0.045em, 400 | hero h1 only |
| h1 | clamp(36px, 4.4vw, 56px) / 1.08 / -0.04em, 400 | page titles, section headlines |
| h2 | clamp(28px, 3.2vw, 44px) / 1.12 / -0.04em, 400 | section headlines (two-tone) |
| h3 | 20–24px / 1.3 / -0.02em, 400–500 | panel titles, plan names |
| h4 | 16px / 1.35 / -0.01em, 500 | row titles, card titles |
| body-lg | 18px / 1.55 / -0.01em | lead paragraphs |
| body | 15px / 1.6 / -0.01em | default |
| small | 13px / 1.45 | meta, hints |
| eyebrow | mono 12px / 1 / 0 tracking, UPPERCASE, `▶` 6px blue triangle before | section labels |
| numeral | mono clamp(72px, 9vw, 128px) / 1 / -0.04em, colour --faint | section index 01–06 |
| data | mono 13px tabular-nums | prices in tables, counts, IDs |

Bold (600+) is not used anywhere. Emphasis = white vs gray, not weight.

### Spacing & grid
- 4px base: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128.
- **Container**: `max-width: 1440px; padding-inline: 20px (≤640) / 32px (≥640)`. Topbar, hero, sections, footer and app pages all use the same container, so every left edge = wordmark left edge.
- App pages: same container; content may use a 12-col grid with a 3-col left rail (page meta / section labels) and 9-col body at ≥1024. Reading text max 68ch.
- Section padding: 128px desktop / 80px mobile. Section header block → content gap 64px / 40px.
- Bands: alternate `--bg` and `--bg-band`, separated by a `--line-2` top border.

### Borders, radius, depth
- Radius: **4px** for panels, inputs, buttons, code blocks; **2px** for chips/tags; never more. No pills, no blobs, no floating cards.
- Panels: `1px --line-2`, background `--bg-raised`, no shadow. Optional **corner ticks** (`Frame` primitive): 8px L-shaped marks at the 4 corners in `--line-3` (accent on hover/active) — our signature precision detail.
- Dividers inside panels: `--line`; table section separators: **dashed** `--line-2`.
- Depth comes from layering (panel over band, sticky header over content), not shadows. The only glow is in the hero (RibField) and an optional 1px accent top-edge on the featured pricing column.

### Controls
- Button heights: sm 32 / md 40 / lg 48; padding-x 12 / 16 / 20; 14–15px, weight 500; radius 4.
  - `primary`: bg --accent, white text; hover --accent-hover; active translateY(1px).
  - `secondary`: bg white, black text (used for the "Get started"-style second CTA where blue would compete).
  - `outline`: transparent, 1px --line-3, white text; hover bg --bg-hover + border #5A5E66.
  - `ghost`: text only, --fg-2 → white on hover; with arrow nudge.
  - No spring lift, no scale bounce.
- Inputs: 40px tall, bg --bg-raised, 1px --line-2, radius 4, 15px; hover border --line-3; focus: border --accent + 3px ring rgb(42 95 255/0.25). Labels 13px --fg-2 above, hints 12px --subtle below.
- Chips/status: dot (6px) + 13px text, or mono 11px uppercase tag in 1px border with 2px radius. No filled pills.
- Tabs: text 14px, active = white + 1px accent underline on the tab bar's bottom border.
- Tables: header mono 11px uppercase --subtle; rows 44–48px, `--line` separators, hover --bg-hover; numerics mono tabular, right-aligned.

### Nav
64px, sticky, `rgb(0 0 0 / 0.8)` + backdrop-blur(12px), bottom border `--line` appears once scrolled (or always on app pages). Wordmark left; links 14px --fg-2 (white on hover/active) left-aligned after the wordmark with 32px gap (not centred); right: `Sign in` (ghost/outline sm) + `Get an eval` (primary sm). Mobile: wordmark + one primary sm + menu button; panel is a full-width sheet with 48px rows.

### Motion
- Tokens: fast 150ms, base 240ms, slow 480ms; easing `cubic-bezier(0.16, 1, 0.3, 1)` (out-expo) for entrances, `cubic-bezier(0.2, 0, 0, 1)` for hovers.
- Entrances: opacity + 8–16px rise, once, stagger 40–60ms. Hero entrance stays **CSS-only** (`.pre` keyframes). anime.js stays lazily imported (CountUp, terminal typing). Motion via LazyMotion `m` only.
- **Reveal must never leave content invisible**: SSR content is visible; animation is only applied when JS has hydrated *and* the element is below the fold at mount. Elements already in view render without animation.
- Hover: colour/border change 150ms; arrow nudge 2px. No lifts, no springs that overshoot, no infinite loops except: RibField (cursor-reactive) and live-status pulse dot.
- prefers-reduced-motion: no transforms, opacity ≤150ms, RibField static frame.
- Compositor-only properties (transform, opacity, clip-path).

## 4. Page compositions

**Landing** (container-aligned, banded):
1. Hero (unchanged positioning): RibField bg; mono eyebrow top of the text block; display headline bottom-left (weight 400); lead + CTA pair bottom-right; feature row = 4 hairline-separated cells (mono label + one short line), single line each, 2×2 at 390.
2. `01 How it works` — left rail eyebrow + numeral; two-tone h2; 5 steps (Submit → Qualify & quote → Test → Find & fix → Report) as a horizontal hairline step grid; beside/below it a **terminal trace block** that shows a run and the found failure (red ✕ line, blue highlight).
3. `02 The report` — product-UI panel (Frame with corner ticks) mimicking a delivered report: header with status, counts row, finding rows with severity dots, one expanded with evidence.
4. `03 Validated fixes` — before/after diff panel + pass bars (0/3 → 3/3, 0 regressions).
5. `04 Pricing` — Neon-style bordered 2-column table: **Fixed** (per package from `PRICE_CENTS`) vs **Per confirmed finding** (`PER_FINDING_CENTS` each, capped at `PER_FINDING_CAP_CENTS`), plus monitoring row (`MONITORING_PRICE_CENTS_MONTHLY`). Mono plan labels, square bullets, dashed separators, CTA per column.
6. `05 Hire us from your agent` — MCP: two-tone h2 + copyable code block with the `claude mcp add …` command.
7. `06 Expert network` — teaser: two numbers + link to /experts.
8. Closing CTA band + footer (4 columns of links, mono legal line).

**App pages**: PageShell = topbar + container; page header = mono eyebrow (section) + h1 (400) + meta row with status chips inline under the title; content in hairline panels; sticky action bars where relevant.

## 5. Accessibility & performance guardrails
- Text contrast ≥ 4.5:1 (tokens above are pre-checked); --faint is decorative only (aria-hidden numerals).
- `:focus-visible` 2px accent outline, offset 2px, on every interactive element.
- Landmarks: header/nav/main/footer; one h1 per page; sections `aria-labelledby`.
- Landing JS: no new heavy deps; hero CSS-only; anime.js dynamic import; images none (UI built in HTML/CSS).
