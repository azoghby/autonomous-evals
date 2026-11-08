"use client";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, type ThHTMLAttributes } from "react";
import type { JobState } from "@ae/core/contracts/index";
import { Eyebrow } from "@/components/ui";
import { EASE } from "./motion";

export const cx = (...c: Array<string | false | null | undefined>): string => c.filter(Boolean).join(" ");

/** A quiet surface (v4: flat hairline panel, 4px radius). Used sparingly. */
export function Glass({ children, className, as: Tag = "div" }: { children: ReactNode; className?: string; as?: "div" | "section" | "article" }) {
  return <Tag className={cx("rounded-[4px] border border-line-2 bg-bg-raised p-5 sm:p-6", className)}>{children}</Tag>;
}

/** Mono eyebrow label (normal tracking, blue marker). */
export function MarkLabel({ children, as: Tag = "h2" }: { children: ReactNode; as?: "h2" | "h3" }) {
  return (
    <Tag className="t-eyebrow inline-flex items-center gap-2 text-fg-2">
      <span aria-hidden className="eyebrow-mark" />
      {children}
    </Tag>
  );
}

/** Hairline-separated block with a mono eyebrow; the default way to group content. */
export function Block({ title, aside, children, className }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("border-t border-line-2 pt-6", className)}>
      {(title || aside) && (
        <div className="mb-4 flex items-center justify-between gap-4">
          {title && <MarkLabel>{title}</MarkLabel>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/* Table language shared by the operator tabs: mono 11px uppercase headers, 48px rows, hairlines, hover wash. */
export const tableCls = "w-full border-collapse text-[14px]";
export const trCls = "h-12 border-t border-line transition-colors duration-150 hover:bg-bg-hover";
export const thCls = "h-10 whitespace-nowrap px-4 text-left align-middle font-mono text-[11px] font-normal uppercase text-subtle";
export const tdCls = "px-4 align-middle whitespace-nowrap";
export const tdNumCls = "px-4 text-right align-middle font-mono text-[13px] tabular-nums";
/** Hairline frame with horizontal scroll so wide tables never widen the page. */
export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("overflow-x-auto rounded-[4px] border border-line-2", className)}>{children}</div>;
}
export function Th({ num, className, ...p }: ThHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return <th {...p} className={cx(thCls, num && "text-right", className)} />;
}

/** Panel section: mono eyebrow + content. Shared by the operator tabs. */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return <Block title={title} aside={aside} className="space-y-4">{children}</Block>;
}

export function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 bg-bg p-5">
      <span className="font-mono text-[11px] uppercase text-subtle">{label}</span>
      <span className="font-mono text-[32px] leading-none tracking-[-0.04em] text-fg tabular-nums">{value}</span>
      <span className="min-h-[18px] text-[13px] text-muted">{note}</span>
    </div>
  );
}

/** Single bordered strip of stats (gap-px on a hairline background draws the dividers). */
export function MetricStrip({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[4px] border border-line-2 bg-line-2 lg:grid-cols-4">{children}</div>;
}

type BtnVariant = "primary" | "ghost" | "danger";
type BtnSize = "sm" | "md" | "lg";
const btnBase = "inline-flex select-none items-center justify-center gap-2 rounded-[4px] font-medium whitespace-nowrap transition-[background-color,border-color,color,opacity] duration-150 active:translate-y-px motion-reduce:active:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";
const btnVariant: Record<BtnVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  ghost: "border border-line-3 text-fg hover:border-[#5a5e66] hover:bg-bg-hover",
  danger: "text-fg-2 hover:bg-bg-hover hover:text-danger",
};
const btnSize: Record<BtnSize, string> = { sm: "h-8 px-3 text-sm", md: "h-10 px-4 text-[15px]", lg: "h-12 px-5 text-[15px]" };

export function Btn({ variant = "primary", size = "md", loading, children, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: BtnSize; loading?: boolean }) {
  const off = p.disabled || loading;
  return (
    <button {...p} disabled={off} className={cx(btnBase, btnVariant[variant], btnSize[size], className)}>
      {loading && <Spinner size={14} />}
      {children}
    </button>
  );
}

export function LinkBtn({ href, variant = "primary", size = "md", children, className }: { href: string; variant?: BtnVariant; size?: BtnSize; children: ReactNode; className?: string }) {
  return <Link href={href} className={cx(btnBase, btnVariant[variant], btnSize[size], className)}>{children}</Link>;
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span role="status" aria-label="Loading" style={{ width: size, height: size }}
      className="inline-block animate-spin rounded-full border-2 border-line-3 border-t-accent motion-reduce:animate-none" />
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[13px] leading-none text-fg-2">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-subtle">{hint}</span>}
      <AnimatePresence initial={false}>
        {error && (
          <motion.span role="alert" key="e" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15, ease: EASE }} className="block text-xs text-danger">{error}</motion.span>
        )}
      </AnimatePresence>
    </label>
  );
}
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(p, ref) {
  return <input ref={ref} {...p} className={cx("input", p.className)} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(p, ref) {
  return <textarea ref={ref} {...p} className={cx("input", p.className)} />;
});

/** Notice for errors, success and info: 4px panel with a tone-coloured left border. Wrap conditionals in <AnimatePresence>. */
export function Banner({ tone = "info", children }: { tone?: "info" | "ok" | "warn" | "bad"; children: ReactNode }) {
  const edge = { info: "border-l-accent", ok: "border-l-ok", warn: "border-l-warn", bad: "border-l-danger" }[tone];
  return (
    <motion.p role={tone === "bad" ? "alert" : "status"}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15, ease: EASE }}
      className={cx("rounded-[4px] border border-l-2 border-line-2 bg-bg-raised px-4 py-3 text-sm text-fg-2", edge)}>
      {children}
    </motion.p>
  );
}

export function ErrorBox({ message, onRetry, title = "Something went wrong" }: { message: string; onRetry?: () => void; title?: string }) {
  return (
    <Banner tone="bad">
      <span className="block font-medium text-fg">{title}</span>
      <span className="block text-muted">{message}</span>
      {onRetry && <button type="button" onClick={onRetry} className="mt-2 text-fg underline decoration-line-3 underline-offset-4 hover:text-accent-text hover:decoration-accent">Try again</button>}
    </Banner>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <h2 className="t-h4">{title}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted">{body}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-24 text-sm text-muted">
      <Spinner size={14} /> {label}
    </div>
  );
}

type Tone = "ok" | "warn" | "bad" | "info" | "muted";
const dotCls: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-danger", info: "bg-accent", muted: "bg-subtle" };
const textCls: Record<Tone, string> = { ok: "text-ok", warn: "text-warn", bad: "text-danger", info: "text-fg-2", muted: "text-muted" };

/** Dot + text. No pill, no border. */
export function Chip({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-2 whitespace-nowrap text-[13px]", textCls[tone])}>
      <span className={cx("size-1.5 rounded-full", dotCls[tone])} aria-hidden />
      {children}
    </span>
  );
}

const STATE_META: Record<JobState, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "muted" },
  needs_clarification: { label: "Needs your answer", tone: "warn" },
  quoted: { label: "Quote ready", tone: "info" },
  awaiting_payment: { label: "Awaiting payment", tone: "warn" },
  planning: { label: "Planning", tone: "info" },
  running: { label: "Running", tone: "info" },
  investigating: { label: "Investigating", tone: "info" },
  delivered: { label: "Delivered", tone: "ok" },
  payment_review: { label: "Payment review", tone: "warn" },
  paused_budget: { label: "Paused", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "muted" },
};
export function StateChip({ state }: { state: JobState }) {
  const m = STATE_META[state] ?? { label: state, tone: "muted" as Tone };
  return <Chip tone={m.tone}>{m.label}</Chip>;
}

export function PageTitle({ title, sub, right, eyebrow }: { title: string; sub?: string; right?: ReactNode; eyebrow?: string }) {
  return (
    <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <Eyebrow className="mb-4">{eyebrow}</Eyebrow>}
        <h1 className="t-h1">{title}</h1>
        {sub && <p className="mt-3 max-w-xl text-base leading-relaxed text-muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[4px] border border-line-2 bg-bg-raised p-3 font-mono text-xs leading-relaxed text-fg-2">{children}</pre>;
}

/** Shown while updates arrive over Neon Realtime (instead of polling). The one live indicator: blue dot + text. */
export function LiveChip() {
  return (
    <span role="status" aria-label="Live updates on" className="inline-flex items-center gap-2 text-[13px] text-fg-2">
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-1.5 rounded-full bg-accent" />
      </span>
      Live
    </span>
  );
}
