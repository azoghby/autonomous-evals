"use client";
import { useId, useState } from "react";
import { Button } from "@/components/ui";

interface PortalResponse { url?: string; error?: string; href?: string; signinUrl?: string }

/** POSTs to /api/billing/portal and sends the browser to the Stripe billing portal. */
export function ManageBillingButton({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [href, setHref] = useState<string | null>(null);
  const errId = useId();

  async function open(): Promise<void> {
    setBusy(true);
    setError(null);
    setHref(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as PortalResponse;
      if (res.ok && data.url) { window.location.assign(data.url); return; }
      if (res.status === 401 && data.signinUrl) { window.location.assign(data.signinUrl); return; }
      setError(data.error ?? "The billing portal is unavailable right now.");
      setHref(data.href ?? null);
    } catch {
      setError("Network error. Please try again.");
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" className={className} onClick={open} disabled={busy} aria-busy={busy} aria-describedby={error ? errId : undefined}>
        {busy ? "Opening..." : "Manage billing"}
      </Button>
      <p id={errId} role="status" aria-live="polite" className={error ? "text-[13px] text-danger" : "sr-only"}>
        {error ?? ""}{error && href ? <> <a className="underline" href={href}>See plans</a></> : null}
      </p>
    </div>
  );
}
