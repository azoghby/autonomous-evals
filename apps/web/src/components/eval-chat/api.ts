import type { ActionResult, EvalChatHistory, EvalRef } from "@/lib/eval-chat/types";

export const chatPath = (ref: EvalRef): string => `/api/evals/${ref.kind}/${encodeURIComponent(ref.id)}/chat`;

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  } catch {
    /* non-JSON error body */
  }
  return `${fallback} (${res.status})`;
}

export async function fetchHistory(ref: EvalRef, signal?: AbortSignal): Promise<EvalChatHistory> {
  const res = await fetch(chatPath(ref), { signal, cache: "no-store" });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not load the conversation"));
  return (await res.json()) as EvalChatHistory;
}

export async function postAction(ref: EvalRef, actionId: string, decision: "confirm" | "cancel"): Promise<ActionResult> {
  const res = await fetch(`${chatPath(ref)}/actions/${encodeURIComponent(actionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) throw new Error(await errorMessage(res, decision === "confirm" ? "Could not confirm" : "Could not cancel"));
  return (await res.json()) as ActionResult;
}
