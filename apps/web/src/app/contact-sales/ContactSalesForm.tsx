"use client";
import { useRef, useState, type FormEvent } from "react";
import { Button, Field, Frame, NudgeArrow } from "@/components/ui";

const VOLUMES = ["<1k trials/mo", "1k-10k", "10k-100k", "100k+", "not sure"] as const;
type FieldErrors = Record<string, string[] | undefined>;

export function ContactSalesForm() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const confirmRef = useRef<HTMLDivElement>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    const body = Object.fromEntries(["name", "workEmail", "company", "agentDescription", "volume", "website"].map((k) => [k, String(fd.get(k) ?? "")]));
    setBusy(true); setFormError(null); setFieldErrors({});
    try {
      const res = await fetch("/api/contact-sales", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
          <h2 className="t-h3">Thanks, we have your note.</h2>
          <p className="t-body mt-3 text-fg-2">Thanks — we&apos;ll reply from a real person within one business day.</p>
        </div>
      </Frame>
    );
  }

  const err = (k: string) => fieldErrors[k]?.[0];
  return (
    <Frame className="p-6 sm:p-8">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <Field id="cs-name" name="name" label="Name" autoComplete="name" required maxLength={200} error={err("name")} />
        <Field id="cs-email" name="workEmail" type="email" label="Work email" autoComplete="email" required maxLength={320} error={err("workEmail") && "Enter a valid work email."} />
        <Field id="cs-company" name="company" label="Company" autoComplete="organization" required maxLength={200} error={err("company")} />
        <Field
          id="cs-agent" name="agentDescription" multiline rows={6} required maxLength={4000}
          label="What does your agent do?"
          hint="Tools it calls, workflows it runs, modalities (text, voice, browser…). At least a sentence or two."
          error={err("agentDescription") && "Tell us a little more (10 characters minimum)."}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="cs-volume" className="text-[13px] leading-none text-fg-2">Expected volume</label>
          <select id="cs-volume" name="volume" className="select" defaultValue="not sure" aria-invalid={err("volume") ? true : undefined}>
            {VOLUMES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        {/* Honeypot: hidden from people and assistive tech. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label>Website<input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" /></label>
        </div>
        <div aria-live="polite" className="min-h-5 text-sm text-danger">{formError}</div>
        <div>
          <Button type="submit" size="lg" disabled={busy}>{busy ? "Sending…" : "Talk to us"} <NudgeArrow size={18} /></Button>
        </div>
      </form>
    </Frame>
  );
}
