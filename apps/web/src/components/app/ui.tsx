"use client";
import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import type { JobState } from "@ae/core/contracts/index";

export const cx = (...c: Array<string | false | null | undefined>): string => c.filter(Boolean).join(" ");

export function Glass({ children, className, as: Tag = "div" }: { children: ReactNode; className?: string; as?: "div" | "section" | "article" }) {
  return (
    <Tag className={cx("rounded-[18px] border border-glass-border bg-glass p-5 shadow-[0_8px_40px_rgb(0_0_0/0.25)] backdrop-blur-xl sm:p-6", className)}>
      {children}
    </Tag>
  );
}

type BtnVariant = "primary" | "ghost" | "danger";
const btnBase = "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98]";
const btnVariant: Record<BtnVariant, string> = {
  primary: "bg-coral text-navy-deep hover:bg-coral-deep hover:text-cream",
  ghost: "border border-glass-border bg-glass text-cream hover:bg-glass-strong",
  danger: "border border-coral/60 text-coral hover:bg-coral/10",
};

export function Btn({ variant = "primary", loading, children, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; loading?: boolean }) {
  return (
    <button {...p} disabled={p.disabled || loading} className={cx(btnBase, btnVariant[variant], className)}>
      {loading && <Spinner size={14} />}
      {children}
    </button>
  );
}

export function LinkBtn({ href, variant = "primary", children, className }: { href: string; variant?: BtnVariant; children: ReactNode; className?: string }) {
  return <Link href={href} className={cx(btnBase, btnVariant[variant], className)}>{children}</Link>;
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span role="status" aria-label="Loading" style={{ width: size, height: size }}
      className="inline-block animate-spin rounded-full border-2 border-cream/30 border-t-coral" />
  );
}

const fieldCls = "w-full rounded-2xl border border-glass-border bg-navy-deep/50 px-4 py-2.5 text-sm text-cream placeholder:text-cream/40 focus:border-coral focus:outline-none focus:ring-2 focus:ring-coral/30";

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-cream">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-cream/60">{hint}</span>}
      {error && <span role="alert" className="block text-xs text-coral">{error}</span>}
    </label>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(fieldCls, p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(fieldCls, "min-h-28 rounded-3xl", p.className)} />;

export function ErrorBox({ message, onRetry, title = "Something went wrong" }: { message: string; onRetry?: () => void; title?: string }) {
  return (
    <Glass className="border-coral/40">
      <h2 className="text-lg font-semibold text-coral">{title}</h2>
      <p className="mt-1 text-sm text-cream/80">{message}</p>
      {onRetry && <Btn variant="ghost" className="mt-4" onClick={onRetry}>Try again</Btn>}
    </Glass>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <Glass className="text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-cream/70">{body}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </Glass>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm text-cream/70">
      <Spinner /> {label}
    </div>
  );
}

type Tone = "ok" | "warn" | "bad" | "info" | "muted";
const toneCls: Record<Tone, string> = {
  ok: "border-[#7fd1a8]/50 bg-[#7fd1a8]/10 text-[#7fd1a8]",
  warn: "border-[#ffc56b]/50 bg-[#ffc56b]/10 text-[#ffc56b]",
  bad: "border-coral/50 bg-coral/10 text-coral",
  info: "border-cream/30 bg-cream/10 text-cream",
  muted: "border-glass-border bg-glass text-cream/70",
};
export function Chip({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", toneCls[tone])}>{children}</span>;
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
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        {sub && <p className="mt-2 max-w-2xl text-sm text-cream/70">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-glass-border bg-navy-deep/70 p-3 font-mono text-xs leading-relaxed text-cream/90">{children}</pre>;
}
