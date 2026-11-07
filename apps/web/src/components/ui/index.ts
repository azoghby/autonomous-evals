/**
 * UI primitives (v4 "Precision Black", see docs/DESIGN_V4.md). Import from "@/components/ui".
 *
 * Rules: black + white + ONE electric blue (primary CTA, eyebrow marker, active state, focus, live dots). 4px radius, 1px hairlines,
 * no shadows/glass/pills, weights 400/500 only (emphasis = white vs gray). Font: Geist (sans, --font-display) + Geist Mono (--font-mono-face).
 *
 * Tokens (Tailwind colours): bg, bg-band, bg-raised, bg-hover, fg, fg-2, muted, subtle, faint (decorative), line, line-2, line-3,
 *   accent, accent-hover, accent-text (blue text on black), accent-soft, ok, warn, danger. Legacy: line-strong=line-3, accent-bright=accent-text.
 *
 * Utility classes (globals.css):
 *   .container-x (1440 max, 20/32px gutters)   .t-display .t-h1 .t-h2 .t-h3 .t-h4 .t-lead .t-body .t-small .t-eyebrow .t-numeral .t-data
 *   .input / .select (40px native controls; textarea.input for multiline)   .frame/.frame-tick (used by Frame)   .text-balance
 *   Hero entrance: .pre .pre-rise .pre-lift .pre-lift-sm .pre-lift-xs .pre-scale (CSS only)   .bolt-underline   .bolt-sweep   .blue-light .grid-lines .ribs
 *
 * Controls
 * - Button      variant: primary | secondary (white) | outline | ghost | quiet; size: sm 32 | md 40 | lg 48; `href` renders a Link. No hover lift.
 * - NudgeArrow  arrow that nudges 2px on hover of a parent `group` (Button is one)
 * - Field       { label, id, hint?, error?, multiline? } + native input/textarea props (uses .input)
 * - Chip        tone: neutral|muted|accent|ok|warn|info|danger; variant: soft (2px mono uppercase bordered tag) | plain (6px dot + 13px text); dot, pulse
 * - StatusChip  { status, variant? } job/finding states -> plain dot + text by default
 *
 * Layout
 * - Container   { as?, className }          container-x wrapper
 * - Section     { id?, band?, labelledBy?, className }   128/80px padding; `band` = bg-band + top hairline; wraps children in Container
 * - Eyebrow     { children, index?, tone?: default|muted|accent }   mono 12px caps + blue triangle
 * - SectionHeader { index?: "01", eyebrow, title: ReactNode, lead?, id?, className? }   rail (eyebrow + faint numeral) + two-tone h2 at >=1024
 * - PageShell   { active?, nav?, narrow?, className }   TopBar + <main id="main" class="container-x"> (narrow = 760px max, left-aligned); className lands on the inner wrapper
 * - TopBar      { nav?, active?, secondary?, cta? }   64px sticky; transparent over the hero on "/" until scrolled
 * - Wordmark, WaveGlyph, BlueLight (very faint atmosphere), RibField (cursor-reactive ribbed hero lines)
 *
 * Surfaces / product visuals
 * - Surface     { strong? }   flat panel: line-2 border, bg-raised, 4px radius
 * - Frame       { ticks? = true, interactive?, as?, className }   hairline panel with 8px corner ticks (accent on hover when interactive)
 * - CodeBlock   { code, label?, copy? = true, language?, className }   mono 13px, Copy button with aria-live, scrolls inside
 * - Terminal    { title?, lines: {text, tone?: default|muted|ok|danger|accent, prefix?}[], animate? }   trace panel; all lines visible on SSR
 * - Stat        { label, value, hint? }   mono label + 32/44px value
 * - KeyValue    { label, children }   hairline row; wrap in <dl>
 * - Spinner, EmptyState, ErrorState, cn
 *
 * Motion (components/ui/motion; reduced-motion aware, SSR-safe, compositor-only; tokens fast .15 / base .24 / slow .48, out-expo):
 * - <Reveal as? delay? y? duration? margin? className?>   fade + 12px rise once; content is VISIBLE on SSR and when already in view at mount
 * - <Stagger as? gap? delay? inView? className?> + <StaggerItem as? y? className?>   same guarantees
 * - <PageTransition className?>   subtle 8px route-enter; first paint is never hidden
 * - <DrawRule>, <CountUp value prefix? suffix? duration?>, useMotionOk(), useMotionDuration(s), motionTokens, springs (critically damped)
 */
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { Surface, type SurfaceProps } from "./GlassCard";
export { NudgeArrow } from "./NudgeArrow";
export * from "./motion";
export { Chip, StatusChip, type ChipProps, type ChipTone, type ChipVariant, type JobStatus, type FindingStatus, type AnyStatus } from "./Chip";
export { Field, type FieldProps } from "./Field";
export { PageShell } from "./PageShell";
export { TopBar, DEFAULT_NAV, type NavItem } from "./TopBar";
export { Wordmark, WaveGlyph } from "./Wordmark";
export { BlueLight } from "./RibbedGlow";
export { RibField } from "./RibField";
export { Spinner } from "./Spinner";
export { EmptyState } from "./EmptyState";
export { ErrorState } from "./ErrorState";
export { cn } from "./cn";
export { Container } from "./Container";
export { Section } from "./Section";
export { Eyebrow, type EyebrowTone } from "./Eyebrow";
export { SectionHeader } from "./SectionHeader";
export { Frame } from "./Frame";
export { CodeBlock } from "./CodeBlock";
export { Terminal, type TerminalLine, type TerminalTone } from "./Terminal";
export { Stat } from "./Stat";
export { KeyValue } from "./KeyValue";
