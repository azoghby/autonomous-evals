/**
 * Small typed client for the Neon REST API v2 (https://console.neon.tech/api/v2).
 * Reads NEON_API_KEY / NEON_PROJECT_ID from env unless a config is passed. The key is
 * only ever placed in the Authorization header; it is never logged or put in errors.
 */

export const NEON_API_BASE = "https://console.neon.tech/api/v2";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface NeonConfig {
  apiKey: string;
  projectId: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface NeonBranch {
  id: string;
  name: string;
  parent_id?: string;
  current_state?: string;
  expires_at?: string | null;
  created_at?: string;
  primary?: boolean;
  default?: boolean;
  protected?: boolean;
}

export interface NeonSnapshot {
  id: string;
  name: string;
  source_branch_id?: string;
  created_at?: string;
  expires_at?: string | null;
  manual?: boolean;
}

export interface NeonOperation { id: string; status: string; action?: string }

export class NeonApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    message: string,
    readonly code?: string,
  ) {
    super(`Neon API ${operation} failed (${status || "network"}): ${message}`);
    this.name = "NeonApiError";
  }
}

export function neonConfigFromEnv(env: Record<string, string | undefined> = process.env): NeonConfig {
  const apiKey = env.NEON_API_KEY;
  const projectId = env.NEON_PROJECT_ID;
  if (!apiKey) throw new NeonApiError(0, "config", "NEON_API_KEY is not set");
  if (!projectId) throw new NeonApiError(0, "config", "NEON_PROJECT_ID is not set");
  return { apiKey, projectId };
}

interface RequestOpts {
  method?: "GET" | "POST" | "PATCH";
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export function createNeonClient(config: NeonConfig = neonConfigFromEnv()) {
  const base = config.baseUrl ?? NEON_API_BASE;
  const doFetch = config.fetch ?? fetch;
  const project = encodeURIComponent(config.projectId);

  async function request<T>(operation: string, path: string, opts: RequestOpts = {}): Promise<T> {
    const url = new URL(`${base}/projects/${project}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: opts.method ?? "GET",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      throw new NeonApiError(0, operation, aborted ? `timed out after ${config.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : "network error");
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : {}; } catch { json = undefined; }
    if (!res.ok) {
      const err = (json ?? {}) as { message?: string; code?: string };
      throw new NeonApiError(res.status, operation, err.message ?? (text.slice(0, 200) || res.statusText), err.code);
    }
    if (json === undefined) throw new NeonApiError(res.status, operation, "response was not valid JSON");
    return json as T;
  }

  return {
    getBranch: async (branchId: string): Promise<NeonBranch> =>
      (await request<{ branch: NeonBranch }>("getBranch", `/branches/${encodeURIComponent(branchId)}`)).branch,

    listBranches: async (): Promise<NeonBranch[]> =>
      (await request<{ branches: NeonBranch[] }>("listBranches", "/branches")).branches ?? [],

    /** Neon only allows snapshots of root branches (a child branch returns 400). */
    createSnapshot: async (branchId: string, name: string, opts: { expiresAt?: Date } = {}): Promise<NeonSnapshot> =>
      (await request<{ snapshot: NeonSnapshot }>("createSnapshot", `/branches/${encodeURIComponent(branchId)}/snapshot`, {
        method: "POST",
        query: { name, expires_at: opts.expiresAt ? toRfc3339(opts.expiresAt) : undefined },
      })).snapshot,

    listSnapshots: async (): Promise<NeonSnapshot[]> =>
      (await request<{ snapshots: NeonSnapshot[] }>("listSnapshots", "/snapshots")).snapshots ?? [],

    /** Always restores to a NEW branch (finalize_restore=false, no target_branch_id): never overwrites main. */
    restoreSnapshot: async (snapshotId: string, newBranchName: string): Promise<{ branch: NeonBranch; operations: NeonOperation[] }> => {
      const r = await request<{ branch: NeonBranch; operations?: NeonOperation[] }>(
        "restoreSnapshot", `/snapshots/${encodeURIComponent(snapshotId)}/restore`,
        { method: "POST", body: { name: newBranchName, finalize_restore: false } },
      );
      return { branch: r.branch, operations: r.operations ?? [] };
    },

    /** Sets (Date) or clears (null) the branch auto-delete time. Max 30 days out; not allowed on default/protected/parent branches. */
    setBranchExpiration: async (branchId: string, expiresAt: Date | null): Promise<NeonBranch> =>
      (await request<{ branch: NeonBranch }>("setBranchExpiration", `/branches/${encodeURIComponent(branchId)}`, {
        method: "PATCH",
        body: { branch: { expires_at: expiresAt ? toRfc3339(expiresAt) : null } },
      })).branch,

    describeProject: async (): Promise<Record<string, unknown>> =>
      (await request<{ project: Record<string, unknown> }>("describeProject", "")).project,
  };
}

export type NeonClient = ReturnType<typeof createNeonClient>;

/** RFC 3339 UTC with second precision, as Neon requires. */
export function toRfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
