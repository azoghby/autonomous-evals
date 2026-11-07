/**
 * UI primitives (navy / cream / coral, ribbed-glass look). Import from "@/components/ui".
 *
 * Design rules: navy + cream, coral is a single accent (primary CTA, one active indicator, key numbers).
 * Prefer whitespace, hairlines (border-cream/10) and typography over boxes and pills.
 *
 * - Button        variant: coral | glass | ghost | quiet (text link) | navy (for cream bg); size: sm | md | lg;
 *                 pass `href` for a Link. Spring hover-lift + press built in (reduced-motion aware).
 * - NudgeArrow    ↗ icon that nudges on hover of a parent `group` (Button already is one)
 * - GlassCard     quiet hairline surface; `strong` for a slightly heavier fill
 * - Chip          tone: neutral | muted | coral | ok | warn | info | danger; variant: soft (pill, default) | plain
 *                 (dot + text); `dot`, `pulse`
 * - StatusChip    status: job states + confirmed / rubric_concern / inconclusive; variant: plain (default, dot + text)
 *                 | soft (filled pill). Only attention states carry a hue.
 * - Field         { label, id, hint?, error?, multiline? } + native input/textarea props
 * - PageShell     app-page frame: dim ribbed glow + TopBar + <main> ({ active?, narrow? })
 * - TopBar, Wordmark, RibbedGlow  building blocks of PageShell / hero
 * - Spinner, EmptyState, ErrorState
 * - cn            class joiner
 *
 * Motion (components/ui/motion, all reduced-motion aware, SSR-safe, compositor-only):
 * - <Reveal as? delay? y? duration? margin? className?>   fade + rise once on scroll into view
 * - <Stagger as? gap? delay? inView? className?> + <StaggerItem as? y? className?>   staggered list/grid reveal
 * - <PageTransition className?>   route-enter fade/rise keyed on pathname; mount once in a layout around {children}
 * - <DrawRule className? delay?>  hairline that draws left-to-right on reveal (colour via text-* / currentColor)
 * - <CountUp value prefix? suffix? duration?>   anime.js count-up on reveal (renders final value for SSR/reduced motion)
 * - useMotionOk()  true unless the user prefers reduced motion; useMotionDuration(s)  clamps to <=0.2s when reduced
 * - motionTokens, springs   shared duration / easing / distance / spring presets
 * Elements carrying `data-reveal` have their transform neutralised under prefers-reduced-motion (see globals.css).
 */
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { GlassCard, type GlassCardProps } from "./GlassCard";
export { NudgeArrow } from "./NudgeArrow";
export * from "./motion";
export { Chip, StatusChip, type ChipProps, type ChipTone, type ChipVariant, type JobStatus, type FindingStatus, type AnyStatus } from "./Chip";
export { Field, type FieldProps } from "./Field";
export { PageShell } from "./PageShell";
export { TopBar, DEFAULT_NAV, type NavItem } from "./TopBar";
export { Wordmark, WaveGlyph } from "./Wordmark";
export { RibbedGlow } from "./RibbedGlow";
export { Spinner } from "./Spinner";
export { EmptyState } from "./EmptyState";
export { ErrorState } from "./ErrorState";
export { cn } from "./cn";
