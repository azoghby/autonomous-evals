"use client";
import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { Button, Frame } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";

type Done = { slug: string; visibility: "public" | "private"; name: string };

export function Confirm({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  async function onConfirm() {
    setState("sending"); setError(null);
    try {
      const r = await api<Done>("/api/leaderboard/verify", { method: "POST", json: { token } });
      setDone(r); setState("done");
    } catch (err) {
      setState("idle");
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    }
  }

  if (state === "done" && done) {
    return (
      <Frame role="status" className="flex flex-col items-start gap-3 p-6 sm:p-8">
        <CircleCheck className="text-ok" size={28} aria-hidden />
        <h2 className="t-h3 text-fg">Confirmed</h2>
        <p className="t-body text-muted">
          Testing of {done.name} will start shortly and we will email you the results.
          {done.visibility === "public" ? " It will appear on the leaderboard once scored." : " Results stay private to you."}
        </p>
      </Frame>
    );
  }
  return (
    <div className="space-y-4">
      {error && <p role="alert" className="rounded-[4px] border border-danger/40 px-3 py-2 text-[14px] text-danger">{error}</p>}
      <Button type="button" size="lg" onClick={onConfirm} disabled={state === "sending"} className="w-full sm:w-auto sm:min-w-[160px]">
        {state === "sending" ? "Confirming..." : "Confirm"}
      </Button>
    </div>
  );
}
