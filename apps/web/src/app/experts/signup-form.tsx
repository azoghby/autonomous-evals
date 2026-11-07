"use client";
import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { Button, Field, GlassCard } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";

type Issues = { fieldErrors?: Record<string, string[] | undefined>; formErrors?: string[] };

function checkbox(id: string, label: string, props: { checked: boolean; onChange: (v: boolean) => void; required?: boolean }) {
  return (
    <label htmlFor={id} className="flex items-start gap-3 text-sm text-cream/85">
      <input id={id} type="checkbox" required={props.required} checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)} className="mt-0.5 size-4 accent-[var(--coral)]" />
      <span>{label}</span>
    </label>
  );
}

export function SignupForm() {
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string[] | undefined>>({});
  const [contact, setContact] = useState(false);
  const [record, setRecord] = useState(false);
  const [attribute, setAttribute] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    const rate = s("rate");
    setState("sending"); setError(null); setFields({});
    try {
      await api("/api/experts/signup", {
        method: "POST",
        json: {
          name: s("name"), email: s("email"), title: s("title"),
          ...(s("organization") ? { organization: s("organization") } : {}),
          domains: s("domains").split(",").map((d) => d.trim()).filter(Boolean),
          ...(s("profileUrl") ? { profileUrl: s("profileUrl") } : {}),
          ...(rate ? { rateCents: Math.round(Number(rate) * 100) } : {}),
          availability: s("availability"),
          consents: { contactForPaidWork: contact, recordCalls: record, attributeByName: attribute },
          hp: s("hp"),
        },
      });
      setState("done");
    } catch (err) {
      setState("idle");
      if (err instanceof ApiError) {
        setError(err.message);
        const issues = (err.body as { issues?: Issues } | undefined)?.issues;
        if (issues?.fieldErrors) setFields(issues.fieldErrors);
      } else setError("Something went wrong. Please try again.");
    }
  }

  if (state === "done") {
    return (
      <GlassCard strong role="status" className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <CircleCheck className="text-ok" size={36} aria-hidden />
        <h2 className="text-xl font-semibold">You are on the list</h2>
        <p className="max-w-sm text-sm text-cream/70">
          When a question in your field comes up, we will email you. A founder reviews every message first, and each one has a one-click opt-out.
        </p>
      </GlassCard>
    );
  }

  const err = (k: string) => fields[k]?.[0];
  return (
    <GlassCard className="p-6 sm:p-8">
      <form onSubmit={onSubmit} noValidate={false} className="space-y-5" aria-describedby={error ? "signup-error" : undefined}>
        <h2 className="text-2xl font-semibold tracking-tight">Join the expert pool</h2>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="name" name="name" label="Full name" required autoComplete="name" error={err("name")} />
          <Field id="email" name="email" type="email" label="Email" required autoComplete="email" error={err("email")} />
          <Field id="title" name="title" label="Title" required error={err("title")} />
          <Field id="organization" name="organization" label="Organization (optional)" autoComplete="organization" />
        </div>
        <Field id="domains" name="domains" label="Domains of expertise" required hint="Comma-separated, up to 5. For example: employment law, ICU nursing" error={err("domains")} />
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="profileUrl" name="profileUrl" type="url" label="Professional profile (optional)" placeholder="https://" error={err("profileUrl")} />
          <Field id="rate" name="rate" type="number" min={0} step="1" inputMode="numeric" label="Hourly rate in USD (optional)" />
        </div>
        <Field id="availability" name="availability" multiline rows={3} label="Availability" required hint="For example: evenings and weekends, about 2 hours a week" error={err("availability")} />
        {/* Honeypot: hidden from people and assistive tech. */}
        <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label>Leave this empty<input name="hp" tabIndex={-1} autoComplete="off" /></label>
        </div>
        <fieldset className="space-y-3 border-t border-cream/10 pt-4">
          <legend className="pr-2 text-sm font-medium">Consent</legend>
          {checkbox("c1", "You may contact me about paid expert work. I understand some messages are written by AI agents and reviewed by a human.", { checked: contact, onChange: setContact, required: true })}
          {checkbox("c2", "You may record calls with me, if I agree again at the start of each call.", { checked: record, onChange: setRecord })}
          {checkbox("c3", "You may credit me by name in reports. Otherwise I stay anonymous.", { checked: attribute, onChange: setAttribute })}
        </fieldset>
        {error && <p id="signup-error" role="alert" className="text-sm text-[#ff8e81]">{error}</p>}
        <Button type="submit" size="lg" disabled={state === "sending"} className="w-full sm:w-auto">
          {state === "sending" ? "Sending..." : "Join the pool"}
        </Button>
      </form>
    </GlassCard>
  );
}
