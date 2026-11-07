"use client";
import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { Button, Field, Frame } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";

type Issues = { fieldErrors?: Record<string, string[] | undefined>; formErrors?: string[] };

function checkbox(id: string, label: string, props: { checked: boolean; onChange: (v: boolean) => void; required?: boolean }) {
  return (
    <label htmlFor={id} className="flex items-start gap-3 text-[14px] leading-[1.5] text-fg-2">
      <input id={id} type="checkbox" required={props.required} checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)} className="mt-[2px] size-4 shrink-0 cursor-pointer accent-[var(--accent)]" />
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
      <Frame role="status" className="flex flex-col items-start gap-3 p-6 sm:p-8">
        <CircleCheck className="text-ok" size={28} aria-hidden />
        <h2 className="t-h3 text-fg">You are on the list</h2>
        <p className="t-body max-w-[48ch] text-muted">
          When a question in your field comes up, we will email you. A founder reviews every message first, and each one has a one-click opt-out.
        </p>
      </Frame>
    );
  }

  const err = (k: string) => fields[k]?.[0];
  return (
    <Frame className="p-6 sm:p-8">
      <form onSubmit={onSubmit} noValidate={false} className="space-y-5" aria-describedby={error ? "signup-error" : undefined}>
        <h2 className="t-h3 text-fg">Join the expert pool</h2>
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
        <fieldset className="space-y-4 border-t border-line-2 pt-5">
          <legend className="t-eyebrow pr-2 text-subtle">Consent</legend>
          {checkbox("c1", "You may contact me about paid expert work. I understand some messages are written by AI agents and reviewed by a human.", { checked: contact, onChange: setContact, required: true })}
          {checkbox("c2", "You may record calls with me, if I agree again at the start of each call.", { checked: record, onChange: setRecord })}
          {checkbox("c3", "You may credit me by name in reports. Otherwise I stay anonymous.", { checked: attribute, onChange: setAttribute })}
        </fieldset>
        {error && <p id="signup-error" role="alert" className="rounded-[4px] border border-danger/40 px-3 py-2 text-[14px] text-danger">{error}</p>}
        <Button type="submit" size="lg" disabled={state === "sending"} className="w-full sm:w-auto sm:min-w-[160px]">
          {state === "sending" ? "Sending..." : "Join the pool"}
        </Button>
      </form>
    </Frame>
  );
}
