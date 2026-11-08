import type { SandboxDraft, SandboxIntakeRequest, ScenarioReviewInput } from "../contract";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; field?: string; issues?: Array<{ path: Array<string | number>; message: string }> };

async function call<T>(url: string, method: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json: unknown = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, data: json as T };
    const e = json as { error?: string; field?: string; issues?: Array<{ path: Array<string | number>; message: string }> };
    return { ok: false, status: res.status, error: e.error ?? statusMessage(res.status), field: e.field, issues: e.issues };
  } catch {
    return { ok: false, status: 0, error: "Network error. Check your connection and try again." };
  }
}

function statusMessage(status: number): string {
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status === 404) return "That draft no longer exists. Start again from step 1.";
  return "Something went wrong. Try again.";
}

export const createDraft = (body: SandboxIntakeRequest) => call<{ draft: SandboxDraft }>("/api/sandbox/drafts", "POST", body);

export const reviewScenario = (draftId: string, scenarioId: string, body: ScenarioReviewInput) =>
  call<{ draft: SandboxDraft }>(`/api/sandbox/drafts/${encodeURIComponent(draftId)}/scenarios/${encodeURIComponent(scenarioId)}`, "PATCH", body);

export const startRun = (draftId: string, k: number) =>
  call<{ runId: string }>(`/api/sandbox/drafts/${encodeURIComponent(draftId)}/runs`, "POST", { k });
