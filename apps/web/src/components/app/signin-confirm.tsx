"use client";
import { useState } from "react";
import { api, errMsg } from "@/lib/client/api";
import { Button, Surface } from "@/components/ui";

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
    <main className="mx-auto max-w-md px-4 pt-20">
      <Surface className="space-y-6 p-8">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-[-0.03em] text-fg">Confirm sign-in</h1>
          <p className="text-sm text-muted">
            You are signing in as <span className="font-mono text-fg">{maskedEmail}</span>. Only continue if you requested this link.
          </p>
        </div>
        <Button variant="primary" size="lg" className="w-full" onClick={confirm} disabled={busy}>
          {busy ? "Signing in…" : "Continue to Autonomous Evals"}
        </Button>
        <p role="alert" aria-live="polite" className="min-h-5 text-sm text-danger">{error}</p>
      </Surface>
    </main>
  );
}
