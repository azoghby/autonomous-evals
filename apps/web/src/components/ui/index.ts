/**
 * UI primitives (navy / cream / coral, ribbed-glass look). Import from "@/components/ui".
 *
 * - Button        variant: coral | glass | ghost; size: sm | md | lg; pass `href` for a Link
 * - GlassCard     translucent card; `strong` for a heavier fill
 * - Chip          tone: neutral | coral | ok | warn | info | danger; `dot`, `pulse`
 * - StatusChip    status: job states + confirmed / rubric_concern / inconclusive
 * - Field         { label, id, hint?, error?, multiline? } + native input/textarea props
 * - PageShell     app-page frame: dim ribbed glow + TopBar + <main> ({ active?, narrow? })
 * - TopBar, Wordmark, RibbedGlow  building blocks of PageShell / hero
 * - Spinner, EmptyState, ErrorState
 * - cn            class joiner
 */
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { GlassCard, type GlassCardProps } from "./GlassCard";
export { Chip, StatusChip, type ChipProps, type ChipTone, type JobStatus, type FindingStatus, type AnyStatus } from "./Chip";
export { Field, type FieldProps } from "./Field";
export { PageShell } from "./PageShell";
export { TopBar, DEFAULT_NAV, type NavItem } from "./TopBar";
export { Wordmark, WaveGlyph } from "./Wordmark";
export { RibbedGlow } from "./RibbedGlow";
export { Spinner } from "./Spinner";
export { EmptyState } from "./EmptyState";
export { ErrorState } from "./ErrorState";
export { cn } from "./cn";
