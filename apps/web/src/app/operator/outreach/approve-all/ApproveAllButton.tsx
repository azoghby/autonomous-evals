"use client";
import { useState } from "react";

interface Summary { total: number; sent: number; approved: number; skipped: number }

export function ApproveAllButton({ token, count }: { token: string; count: number }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");

  async function go() {
    setState("busy");
    try {
      const res = await fetch("/api/operator/outreach/approve-all", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: token }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? "Request failed"); setState("error"); return; }
      setSummary(json as Summary); setState("done");
    } catch { setError("Network error"); setState("error"); }
  }

  if (state === "done" && summary) {
    return <p role="status">Done: {summary.sent} sent, {summary.approved} approved (not sent), {summary.skipped} skipped of {summary.total}.</p>;
  }
  return (
    <div>
      <button type="button" onClick={go} disabled={state === "busy"} style={{ padding: "10px 18px", fontWeight: 600, cursor: "pointer" }}>
        {state === "busy" ? "Sending..." : `Approve and send all ${count}`}
      </button>
      {state === "error" && <p role="alert">{error}</p>}
    </div>
  );
}
