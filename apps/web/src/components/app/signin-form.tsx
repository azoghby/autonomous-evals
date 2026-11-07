"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, errMsg } from "@/lib/client/api";
import { Btn, Field, Glass, Input, PageTitle } from "./ui";

export function SignInForm() {
  const next = useSearchParams().get("next");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ devLink?: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email)) { setError("Enter a valid email address."); return; }
    setBusy(true);
    try {
      const r = await api<{ devLink?: string } | undefined>("/api/auth/request-link", {
        method: "POST", json: { email, ...(next ? { next } : {}) },
      });
      setSent({ devLink: r?.devLink });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md pt-10">
      <PageTitle title="Sign in" sub="No password. We email you a one-time link." />
      <Glass>
        {sent ? (
          <div className="space-y-3" aria-live="polite">
            <h2 className="text-lg font-semibold">Check your email</h2>
            <p className="text-sm text-cream/75">We sent a sign-in link to <span className="font-medium text-cream">{email}</span>. It expires shortly.</p>
            {sent.devLink && (
              <p className="rounded-2xl border border-glass-border bg-navy-deep/50 p-3 text-xs">
                Dev mode: <a className="break-all text-coral underline" href={sent.devLink}>{sent.devLink}</a>
              </p>
            )}
            <Btn variant="ghost" onClick={() => setSent(null)}>Use a different email</Btn>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <Field label="Email" error={error ?? undefined}>
              <Input type="email" autoComplete="email" required placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Btn type="submit" loading={busy} className="w-full">Email me a link</Btn>
          </form>
        )}
      </Glass>
    </div>
  );
}
