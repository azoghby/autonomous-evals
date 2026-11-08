"use client";
import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { Button, Eyebrow, Frame } from "@/components/ui";
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
      <Frame role="status" className="flex flex-col items-start gap-3 p-6 sm:p-8">
        <CircleCheck className="text-ok" size={28} aria-hidden />
        <h1 className="t-h1 text-fg">You are opted out</h1>
        <p className="t-lead max-w-[48ch]">We will not contact this address again.</p>
      </Frame>
    );
  }
  return (
    <div className="space-y-6">
      <Eyebrow>Opt out</Eyebrow>
      <h1 className="t-h1 text-balance">Stop all emails from Standard Evals?</h1>
      <Frame className="space-y-5 p-6 sm:p-8">
      <p className="t-body max-w-[56ch] text-muted">
        This adds your address to our do-not-contact list and removes you from the expert pool. Open invitations are cancelled.
      </p>
      {error && <p role="alert" className="rounded-[4px] border border-danger/40 px-3 py-2 text-[14px] text-danger">{error}</p>}
      <Button size="lg" onClick={() => void confirm()} disabled={state === "sending"}>{state === "sending" ? "Working..." : "Yes, opt me out"}</Button>
      </Frame>
    </div>
  );
}
