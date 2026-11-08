"use client";
import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { Button, Field, Frame } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";

type Issues = { fieldErrors?: Record<string, string[] | undefined> };

function checkbox(id: string, label: string, props: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-start gap-3 text-[14px] leading-[1.5] text-fg-2">
      <input id={id} type="checkbox" required checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)} className="mt-[2px] size-4 shrink-0 cursor-pointer accent-[var(--accent)]" />
      <span>{label}</span>
    </label>
  );
}

export function SubmitForm({ authorizeText, emailsText }: { authorizeText: string; emailsText: string }) {
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string[] | undefined>>({});
  const [authorize, setAuthorize] = useState(false);
  const [emails, setEmails] = useState(false);
  const [visibility, setVisibility] = useState<"public" | "private">("public");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    setState("sending"); setError(null); setFields({});
    try {
      await api("/api/leaderboard/submit", {
        method: "POST",
        json: {
          ownerEmail: s("ownerEmail"), agentName: s("agentName"), org: s("org"), endpointUrl: s("endpointUrl"), model: s("model"),
          ...(s("apiKey") ? { apiKey: s("apiKey") } : {}),
          ...(s("systemPrompt") ? { systemPrompt: s("systemPrompt") } : {}),
          visibility, consentAuthorize: authorize, consentEmails: emails, hp: s("hp"),
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
        <h2 className="t-h3 text-fg">Check your inbox</h2>
        <p className="t-body max-w-[48ch] text-muted">
          We sent a confirm link to your email. It is valid for 48 hours and nothing runs until you press Confirm.
        </p>
      </Frame>
    );
  }

  const err = (k: string) => fields[k]?.[0];
  return (
    <Frame className="p-6 sm:p-8">
      <form onSubmit={onSubmit} className="space-y-5" aria-describedby={error ? "submit-error" : undefined}>
        <h2 className="t-h3 text-fg">Submit an agent</h2>
        <Field id="ownerEmail" name="ownerEmail" type="email" label="Your email" required autoComplete="email" error={err("ownerEmail")} />
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="agentName" name="agentName" label="Agent name" required maxLength={120} error={err("agentName")} />
          <Field id="org" name="org" label="Organization" required maxLength={120} autoComplete="organization" error={err("org")} />
        </div>
        <Field id="endpointUrl" name="endpointUrl" type="url" label="Endpoint URL" required placeholder="https://api.example.com/v1/chat/completions"
          hint="Full OpenAI-compatible chat completions URL. HTTPS only." error={err("endpointUrl")} />
        <Field id="model" name="model" label="Model" required maxLength={200} error={err("model")} />
        <Field id="apiKey" name="apiKey" type="password" label="API key (optional)" autoComplete="off" maxLength={500}
          hint="Encrypted at rest and used only to run these tests. Use a key you can revoke." error={err("apiKey")} />
        <Field id="systemPrompt" name="systemPrompt" multiline rows={4} maxLength={20000} label="System prompt (optional)" error={err("systemPrompt")} />
        <fieldset className="space-y-3">
          <legend className="text-[13px] leading-none text-fg-2">Results visibility</legend>
          {(["public", "private"] as const).map((v) => (
            <label key={v} className="flex items-start gap-3 text-[14px] leading-[1.5] text-fg-2">
              <input type="radio" name="visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)}
                className="mt-[2px] size-4 shrink-0 cursor-pointer accent-[var(--accent)]" />
              <span>{v === "public" ? "Public: show my agent on the leaderboard" : "Private: send results to me only"}</span>
            </label>
          ))}
        </fieldset>
        {/* Honeypot: hidden from people and assistive tech. */}
        <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label>Leave this empty<input name="hp" tabIndex={-1} autoComplete="off" /></label>
        </div>
        <fieldset className="space-y-4 border-t border-line-2 pt-5">
          <legend className="t-eyebrow pr-2 text-subtle">Consent (both required)</legend>
          {checkbox("consent-authorize", authorizeText, { checked: authorize, onChange: setAuthorize })}
          {checkbox("consent-emails", emailsText, { checked: emails, onChange: setEmails })}
        </fieldset>
        {error && <p id="submit-error" role="alert" className="rounded-[4px] border border-danger/40 px-3 py-2 text-[14px] text-danger">{error}</p>}
        <Button type="submit" size="lg" disabled={state === "sending" || !authorize || !emails} className="w-full sm:w-auto sm:min-w-[160px]">
          {state === "sending" ? "Sending..." : "Submit for testing"}
        </Button>
      </form>
    </Frame>
  );
}
