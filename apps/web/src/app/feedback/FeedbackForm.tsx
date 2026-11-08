"use client";
import { useRef, useState, type FormEvent } from "react";
import { Button, Field, Frame, NudgeArrow } from "@/components/ui";

const CHOICES = [
  { value: "yes", label: "Yes" },
  { value: "maybe", label: "Maybe" },
  { value: "no", label: "No" },
] as const;
type FieldErrors = Record<string, string[] | undefined>;
type Props = { refToken: string | null };

export function FeedbackForm({ refToken }: Props) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const confirmRef = useRef<HTMLDivElement>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    const text = (k: string) => String(fd.get(k) ?? "");
    const body = {
      ref: refToken, wouldUse: text("wouldUse"), mustHave: text("mustHave"), pricePerMonth: text("pricePerMonth"),
      quote: text("quote"), quoteConsent: fd.get("quoteConsent") === "on", name: text("name"), company: text("company"), website: text("website"),
    };
    setBusy(true); setFormError(null); setFieldErrors({});
    try {
      const res = await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; fieldErrors?: FieldErrors };
      if (res.ok && data.ok) { setDone(true); queueMicrotask(() => confirmRef.current?.focus()); return; }
      setFieldErrors(data.fieldErrors ?? {});
      setFormError(data.error ?? "Something went wrong. Please try again.");
    } catch {
      setFormError("Network error. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Frame className="p-6 sm:p-8">
        <div ref={confirmRef} tabIndex={-1} role="status" className="outline-none">
          <h2 className="t-h3">Thank you. That genuinely helps.</h2>
          <p className="t-body mt-3 text-fg-2">Ronit reads every answer. If you want to say more, just reply to the email.</p>
        </div>
      </Frame>
    );
  }

  const err = (k: string) => fieldErrors[k]?.[0];
  return (
    <Frame className="p-6 sm:p-8">
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6" aria-label="Feedback form">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-3 text-[15px] text-fg">Would you actually use this?</legend>
          <div className="flex flex-wrap gap-3">
            {CHOICES.map((c) => (
              <label key={c.value} className="flex cursor-pointer items-center gap-2 rounded-[4px] border border-line-2 px-4 py-2.5 text-[14px] text-fg-2 transition-colors hover:border-fg-2 has-[:checked]:border-accent has-[:checked]:text-fg">
                <input type="radio" name="wouldUse" value={c.value} required className="accent-[var(--accent)]" />
                {c.label}
              </label>
            ))}
          </div>
          {err("wouldUse") && <p className="text-sm text-danger">Pick yes, maybe or no.</p>}
        </fieldset>
        <Field id="fb-must" name="mustHave" multiline rows={4} maxLength={2000} label="What would make it a must-have for you?"
          hint="Missing features, integrations, trust, price… anything." error={err("mustHave")} />
        <Field id="fb-price" name="pricePerMonth" label="What would you pay per month?" maxLength={120}
          hint="A number, a range, or “nothing”. All honest answers help." error={err("pricePerMonth")} />
        <Field id="fb-quote" name="quote" multiline rows={3} maxLength={600} label="A sentence we may quote publicly (optional)" error={err("quote")} />
        <label className="flex cursor-pointer items-start gap-3 text-[14px] text-fg-2">
          <input type="checkbox" name="quoteConsent" className="mt-[3px] size-4 shrink-0 cursor-pointer accent-[var(--accent)]" />
          <span>Yes, Standard Evals may show this quote on its website, with the name and company I enter below (if any).</span>
        </label>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="fb-name" name="name" label="Name (optional)" autoComplete="name" maxLength={200} error={err("name")} />
          <Field id="fb-company" name="company" label="Company (optional)" autoComplete="organization" maxLength={200} error={err("company")} />
        </div>
        {/* Honeypot: hidden from people and assistive tech. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label>Website<input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" /></label>
        </div>
        <div aria-live="polite" className="min-h-5 text-sm text-danger">{formError}</div>
        <div>
          <Button type="submit" size="lg" disabled={busy}>{busy ? "Sending…" : "Send feedback"} <NudgeArrow size={18} /></Button>
        </div>
      </form>
    </Frame>
  );
}
