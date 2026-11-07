"use client";
import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { Button, Surface } from "@/components/ui";
import { api, errMsg } from "@/lib/client/api";

export function OptOut({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setState("sending"); setError(null);
    try {
      await api(`/api/expert/opt-out/${encodeURIComponent(token)}`, { method: "POST" });
      setState("done");
    } catch (e) { setState("idle"); setError(errMsg(e)); }
  }

  if (state === "done") {
    return (
      <Surface strong role="status" className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <CircleCheck className="text-ok" size={36} aria-hidden />
        <h1 className="text-2xl font-semibold">You are opted out</h1>
        <p className="max-w-sm text-sm text-muted">We will not contact this address again.</p>
      </Surface>
    );
  }
  return (
    <Surface strong className="space-y-4 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Stop all emails from Autonomous Evals?</h1>
      <p className="text-sm text-muted">
        This adds your address to our do-not-contact list and removes you from the expert pool. Open invitations are cancelled.
      </p>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button onClick={() => void confirm()} disabled={state === "sending"}>{state === "sending" ? "Working..." : "Yes, opt me out"}</Button>
    </Surface>
  );
}
