"use client";
import { useState } from "react";

interface Props { token: string; label: string; danger: boolean }

export function DecideButton({ token, label, danger }: Props) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function go() {
    setState("busy");
    try {
      const res = await fetch("/api/notify/decide", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: token }),
      });
      const json = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) { setMessage(json.error ?? "Request failed"); setState("error"); return; }
      setMessage(json.message ?? "Done."); setState("done");
    } catch { setMessage("Network error"); setState("error"); }
  }

  if (state === "done") return <p role="status">{message}</p>;
  return (
    <div>
      <button type="button" onClick={go} disabled={state === "busy"}
        style={{ padding: "12px 20px", fontWeight: 600, fontSize: 16, cursor: "pointer", borderRadius: 8, border: "1px solid #ccc", background: danger ? "#fbe9e9" : "#e8f5e9" }}>
        {state === "busy" ? "Working..." : `Confirm: ${label}`}
      </button>
      {state === "error" && <p role="alert">{message}</p>}
    </div>
  );
}
