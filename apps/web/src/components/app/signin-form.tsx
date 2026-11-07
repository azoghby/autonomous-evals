"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, errMsg } from "@/lib/client/api";
import { AnimatePresence, motion } from "motion/react";
import { Banner, Btn, Field, Input, PageTitle } from "./ui";
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
    <div className="mx-auto max-w-md pt-16">
      <PageTitle title="Sign in" sub="No password. We email you a one-time link." />
      <AnimatePresence>{authError && !sent && <div className="mb-6"><Banner key="ae" tone="bad">{authError}</Banner></div>}</AnimatePresence>
      <AnimatePresence mode="wait" initial={false}>
        {sent ? (
          <motion.div key="sent" {...swap} className="space-y-4" aria-live="polite">
            <h2 className="text-lg font-medium">Check your email</h2>
            <p className="text-sm text-cream/65">We sent a sign-in link to <span className="text-cream">{email}</span>. It expires shortly.</p>
            {sent.devLink && (
              <p className="border-l border-white/20 pl-4 text-xs text-cream/60">
                Dev mode: <a className="break-all text-cream underline decoration-cream/30 underline-offset-4" href={sent.devLink}>{sent.devLink}</a>
              </p>
            )}
            <Btn variant="ghost" onClick={() => setSent(null)}>Use a different email</Btn>
          </motion.div>
        ) : (
          <motion.form key="form" {...swap} onSubmit={submit} className="space-y-5" noValidate>
            <Field label="Email" error={error ?? undefined}>
              <Input type="email" autoComplete="email" required placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Btn type="submit" loading={busy} className="w-full">Email me a link</Btn>
          </motion.form>
        )}
      </AnimatePresence>
    </div>
  );
}
