export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      credentials: "same-origin",
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, "Network error. Check your connection and try again.");
  }
  const text = await res.text();
  let body: unknown = undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
  if (!res.ok) {
    const b = body as { error?: unknown; message?: unknown } | undefined;
    const msg = typeof b?.error === "string" ? b.error : typeof b?.message === "string" ? b.message
      : res.status === 404 ? "Not found." : res.status === 403 ? "You do not have access to this." : `Request failed (${res.status}).`;
    throw new ApiError(res.status, msg, body);
  }
  return body as T;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

export const dollars = (cents: number): string =>
  `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
export const microUsd = (m: number): string => `$${(m / 1_000_000).toFixed(2)}`;
export const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

export const PACKAGE_LABEL: Record<string, string> = {
  trace_audit: "Trace Audit",
  text_eval: "Text Eval",
  workflow_eval: "Workflow Eval",
  version_comparison: "Version Comparison",
};
