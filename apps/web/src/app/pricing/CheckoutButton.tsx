"use client";
import { useId, useState, type ReactNode } from "react";
import { Button, type ButtonVariant } from "@/components/ui";

export type CheckoutRequest =
  | { kind: "plan"; plan: "pro" | "scale"; interval: "month" | "year" }
  | { kind: "audit" };

/** POSTs to /api/billing/checkout and redirects to the returned Stripe URL. Errors render inline (aria-live). */
export function CheckoutButton({
  request, children, variant = "primary", size = "md", className,
}: { request: CheckoutRequest; children: ReactNode; variant?: ButtonVariant; size?: "sm" | "md" | "lg"; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errId = useId();

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string; signinUrl?: string };
      if (res.ok && data.url) { window.location.assign(data.url); return; }
      if (res.status === 401 && data.signinUrl) { window.location.assign(data.signinUrl); return; }
      setError(data.error ?? "Could not start checkout. Please try again.");
    } catch {
      setError("Network error. Please try again.");
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={start}
        disabled={busy}
        aria-busy={busy}
        aria-describedby={error ? errId : undefined}
      >
        {busy ? "Redirecting..." : children}
      </Button>
      <p id={errId} role="status" aria-live="polite" className={error ? "text-[13px] text-danger" : "sr-only"}>{error ?? ""}</p>
    </div>
  );
}
