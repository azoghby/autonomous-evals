"use client";
import { useState } from "react";
import { api, errMsg } from "@/lib/client/api";
import { Button, Eyebrow } from "@/components/ui";

export function SignInConfirm({ token, next, maskedEmail }: { token: string; next: string; maskedEmail: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ redirect: string }>("/api/auth/verify", { method: "POST", json: { token, next } });
      window.location.assign(r.redirect);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[440px] pt-2 sm:pt-8">
      <Eyebrow>Account</Eyebrow>
      <h1 className="t-h1 mt-4 text-fg">Confirm sign-in</h1>
      <p className="t-lead mt-3">
        You are signing in as <span className="t-data text-fg">{maskedEmail}</span>. Only continue if you requested this link.
      </p>
      <div className="mt-8 border-t border-line pt-8">
        <Button variant="primary" size="lg" className="w-full" onClick={confirm} disabled={busy}>
          {busy ? "Signing in…" : "Continue to Standard Evals"}
        </Button>
        <p role="alert" aria-live="polite" className="mt-3 min-h-5 text-sm text-danger">{error}</p>
      </div>
    </div>
  );
}
