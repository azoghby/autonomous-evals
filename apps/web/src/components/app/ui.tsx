"use client";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import type { JobState } from "@ae/core/contracts/index";
import { EASE, SPRING } from "./motion";

export const cx = (...c: Array<string | false | null | undefined>): string => c.filter(Boolean).join(" ");

/** A quiet surface. Used sparingly: most content sits directly on the page, separated by space and hairlines. */
export function Glass({ children, className, as: Tag = "div" }: { children: ReactNode; className?: string; as?: "div" | "section" | "article" }) {
  return <Tag className={cx("rounded-2xl bg-white/[0.035] p-5 sm:p-6", className)}>{children}</Tag>;
}

/** Hairline-separated block with a small label; the default way to group content. */
export function Block({ title, aside, children, className }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("border-t border-white/10 pt-6", className)}>
      {(title || aside) && (
        <div className="mb-4 flex items-baseline justify-between gap-4">
          {title && <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-cream/50">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

type BtnVariant = "primary" | "ghost" | "danger";
const btnBase = "inline-flex select-none items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream disabled:cursor-not-allowed disabled:opacity-40";
const btnVariant: Record<BtnVariant, string> = {
  primary: "bg-coral font-semibold text-navy-deep hover:bg-cream",
  ghost: "bg-white/[0.07] text-cream hover:bg-white/[0.12]",
  danger: "text-cream/70 hover:bg-white/[0.07] hover:text-cream",
};
const press = { whileTap: { scale: 0.96 }, transition: SPRING } as const;

export function Btn({ variant = "primary", loading, children, className, ...p }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart"> & { variant?: BtnVariant; loading?: boolean }) {
  const off = p.disabled || loading;
  return (
    <motion.button {...p} disabled={off} whileTap={off ? undefined : press.whileTap} transition={press.transition} className={cx(btnBase, btnVariant[variant], className)}>
      {loading && <Spinner size={14} />}
      {children}
    </motion.button>
  );
}

const MotionLink = motion.create(Link);
export function LinkBtn({ href, variant = "primary", children, className }: { href: string; variant?: BtnVariant; children: ReactNode; className?: string }) {
  return <MotionLink href={href} whileTap={press.whileTap} transition={press.transition} className={cx(btnBase, btnVariant[variant], className)}>{children}</MotionLink>;
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span role="status" aria-label="Loading" style={{ width: size, height: size }}
      className="inline-block animate-spin rounded-full border-2 border-cream/20 border-t-cream/80 motion-reduce:animate-none" />
  );
}

const fieldCls = "w-full rounded-xl bg-white/[0.05] px-4 py-2.5 text-sm text-cream placeholder:text-cream/30 outline-none ring-1 ring-inset ring-white/10 transition focus:bg-white/[0.07] focus:ring-cream/40";

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm text-cream/80">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-cream/45">{hint}</span>}
      <AnimatePresence initial={false}>
        {error && (
          <motion.span role="alert" key="e" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease: EASE }} className="block text-xs text-coral">{error}</motion.span>
        )}
      </AnimatePresence>
    </label>
  );
}
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(p, ref) {
  return <input ref={ref} {...p} className={cx(fieldCls, p.className)} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(p, ref) {
  return <textarea ref={ref} {...p} className={cx(fieldCls, "min-h-28 leading-relaxed", p.className)} />;
});

/** Slide-in notice for errors, success and info. Wrap conditionals in <AnimatePresence>. */
export function Banner({ tone = "info", children }: { tone?: "info" | "ok" | "warn" | "bad"; children: ReactNode }) {
  const dot = { info: "bg-cream/60", ok: "bg-ok", warn: "bg-warn", bad: "bg-coral" }[tone];
  return (
    <motion.p role={tone === "bad" ? "alert" : "status"} layout
      initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.35, ease: EASE }}
      className="flex items-start gap-3 border-l border-white/20 py-1 pl-4 text-sm text-cream/80">
      <span className={cx("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", dot)} aria-hidden />
      <span>{children}</span>
    </motion.p>
  );
}

export function ErrorBox({ message, onRetry, title = "Something went wrong" }: { message: string; onRetry?: () => void; title?: string }) {
  return (
    <Banner tone="bad">
      <span className="block font-medium text-cream">{title}</span>
      <span className="block text-cream/65">{message}</span>
      {onRetry && <button type="button" onClick={onRetry} className="mt-2 text-cream underline decoration-cream/30 underline-offset-4 hover:decoration-cream">Try again</button>}
    </Banner>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="py-16 text-center">
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-cream/60">{body}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-24 text-sm text-cream/55">
      <Spinner size={14} /> {label}
    </div>
  );
}

type Tone = "ok" | "warn" | "bad" | "info" | "muted";
const dotCls: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-coral/80", info: "bg-cream/70", muted: "bg-cream/30" };

/** Dot + text. No pill, no border. */
export function Chip({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-cream/70">
      <span className={cx("h-1.5 w-1.5 rounded-full", dotCls[tone])} aria-hidden />
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

export function PageTitle({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        {sub && <p className="mt-2 max-w-xl text-sm leading-relaxed text-cream/55">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/25 p-3 font-mono text-xs leading-relaxed text-cream/80">{children}</pre>;
}

/** Shown while updates arrive over Neon Realtime (instead of polling). The one live indicator: coral dot + text. */
export function LiveChip() {
  return (
    <span role="status" aria-label="Live updates on" className="inline-flex items-center gap-2 text-xs font-medium text-cream/80">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-coral opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-coral" />
      </span>
      Live
    </span>
  );
}
