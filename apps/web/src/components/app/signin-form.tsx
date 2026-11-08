"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, errMsg } from "@/lib/client/api";
import { AnimatePresence, motion } from "motion/react";
import { Button, Field } from "@/components/ui";
import { Banner } from "./ui";
import { PageHead } from "./page-parts";
import { EASE } from "./motion";

const swap = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 }, transition: { duration: 0.3, ease: EASE } } as const;

const AUTH_ERRORS: Record<string, string> = {
  invalid: "This sign-in link is invalid. Request a new one below.",
  used: "This sign-in link was already used. Request a new one below.",
  expired: "This sign-in link expired. Request a new one below.",
};

export function SignInForm() {
  const params = useSearchParams();
  const next = params.get("next");
  const authError = AUTH_ERRORS[params.get("auth_error") ?? ""];
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
    <div className="max-w-[440px] pt-2 sm:pt-8">
      <PageHead eyebrow="Account" title="Sign in" lead="No password. We email you a one-time link." />
      <AnimatePresence>{authError && !sent && <div className="mb-6"><Banner key="ae" tone="bad">{authError}</Banner></div>}</AnimatePresence>
      <AnimatePresence mode="wait" initial={false}>
        {sent ? (
          <motion.div key="sent" {...swap} className="space-y-5" aria-live="polite">
            <h2 className="t-h3 text-fg">Check your email</h2>
            <p className="text-[15px] text-muted">We sent a sign-in link to <span className="t-data text-fg">{email}</span>. It expires shortly.</p>
            {sent.devLink && (
              <div className="rounded-[4px] border border-line-2 bg-bg-raised">
                <p className="t-eyebrow border-b border-line px-3 py-2.5 text-subtle">Dev link</p>
                <p className="t-data break-all px-3 py-3 text-fg-2">
                  <a className="text-accent-text underline-offset-4 hover:underline" href={sent.devLink}>{sent.devLink}</a>
                </p>
              </div>
            )}
            <Button variant="outline" onClick={() => setSent(null)}>Use a different email</Button>
          </motion.div>
        ) : (
          <motion.form key="form" {...swap} onSubmit={submit} className="space-y-5" noValidate>
            <Field id="signin-email" label="Email" type="email" autoComplete="email" required placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} error={error ?? undefined} />
            <Button type="submit" size="lg" className="w-full" disabled={busy}>{busy ? "Sending…" : "Email me a link"}</Button>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}
