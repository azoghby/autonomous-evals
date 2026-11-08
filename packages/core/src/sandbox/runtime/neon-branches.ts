/**
 * NeonBranchManager over the Neon REST API v2.
 *
 * - Mutating calls (create / restore / delete) are serialized per project in-process, including the
 *   wait for their operations, so we never trigger 423 (Locked) ourselves.
 * - 423 / 503 are retried with exponential backoff + jitter; network errors are retried for GET only.
 * - The API key is only placed in the Authorization header and scrubbed from every error message.
 */
import type { BranchInfo, NeonBranchManager } from "./types";

export const NEON_BRANCHES_API_BASE = "https://console.neon.tech/api/v2";

const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 2;
const BACKOFF_CAP_MS = 10_000;
const JITTER_RATIO = 0.25;
const BODY_SNIPPET_MAX = 200;
const RETRYABLE_STATUS = new Set([423, 503]);
const OP_DONE = new Set(["finished", "skipped", "cancelled"]);
const OP_FAILED = new Set(["failed", "error"]);
const SYSTEM_ROLE_PREFIXES = ["cloud_admin", "neon_superuser", "authenticator", "anonymous", "authenticated"];
const PREFERRED_ROLE = "neondb_owner";

const BRANCH_ID_RE = /^br-[a-z0-9-]+$/;
const PROJECT_ID_RE = /^[a-z0-9-]{1,60}$/;

export interface NeonBranchManagerConfig {
  apiKey: string;
  projectId: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  pollIntervalMs?: number;
  operationTimeoutMs?: number;
}

export class NeonBranchError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    message: string,
  ) {
    super(`Neon branches ${operation} failed (${status || "network"}): ${message}`);
    this.name = "NeonBranchError";
  }
}

interface RawBranch {
  id: string;
  name: string;
  parent_id?: string;
  expires_at?: string | null;
  default?: boolean;
  primary?: boolean;
}
interface RawOperation { id: string; status: string }
interface MutationResponse { branch?: RawBranch; operations?: RawOperation[] }

/* One promise chain per project, shared by every manager instance in this process. */
const projectLocks = new Map<string, Promise<unknown>>();

function runExclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = projectLocks.get(projectId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  projectLocks.set(projectId, tail);
  void tail.then(() => {
    if (projectLocks.get(projectId) === tail) projectLocks.delete(projectId);
  });
  return run;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function assertBranchId(id: string, label = "branch id"): void {
  if (typeof id !== "string" || !BRANCH_ID_RE.test(id)) throw new NeonBranchError(0, "validate", `invalid ${label}`);
}

function toRfc3339Seconds(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new NeonBranchError(0, "validate", "invalid expiresAt date");
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function toInfo(b: RawBranch): BranchInfo {
  return {
    branchId: b.id,
    name: b.name,
    ...(b.parent_id ? { parentId: b.parent_id } : {}),
    ...(b.expires_at !== undefined ? { expiresAt: b.expires_at } : {}),
  };
}

function isSystemRole(name: string): boolean {
  return SYSTEM_ROLE_PREFIXES.some((p) => name.startsWith(p));
}

interface RequestOptions {
  operation: string;
  body?: unknown;
  query?: Record<string, string>;
  /** Statuses (besides 2xx) that resolve to `null` instead of throwing. */
  tolerate?: number[];
}

export function createNeonBranchManager(config: NeonBranchManagerConfig): NeonBranchManager {
  const { apiKey, projectId } = config;
  if (!apiKey) throw new NeonBranchError(0, "config", "apiKey is required");
  if (!PROJECT_ID_RE.test(projectId ?? "")) throw new NeonBranchError(0, "config", "invalid projectId");

  const baseUrl = (config.baseUrl ?? NEON_BRANCHES_API_BASE).replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const sleep = config.sleep ?? defaultSleep;
  const maxRetries = config.maxRetries ?? 8;
  const pollIntervalMs = config.pollIntervalMs ?? 500;
  const operationTimeoutMs = config.operationTimeoutMs ?? 120_000;
  const roleCache = new Map<string, string>();
  const projectPath = `/projects/${projectId}`;

  const scrub = (text: string): string => {
    const cleaned = apiKey ? text.split(apiKey).join("[redacted]") : text;
    return cleaned.length > BODY_SNIPPET_MAX ? `${cleaned.slice(0, BODY_SNIPPET_MAX)}...` : cleaned;
  };

  const backoffMs = (attempt: number): number => {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * BACKOFF_FACTOR ** attempt);
    return Math.round(base + Math.random() * base * JITTER_RATIO);
  };

  async function request<T>(method: "GET" | "POST" | "DELETE", path: string, opts: RequestOptions): Promise<T | null> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
    const url = `${baseUrl}${path}${qs}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (method === "GET" && attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        const msg = err instanceof Error ? err.message : "request failed";
        throw new NeonBranchError(0, opts.operation, scrub(msg));
      }

      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      const text = await res.text().catch(() => "");
      if (res.status >= 200 && res.status < 300) {
        if (!text) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new NeonBranchError(res.status, opts.operation, "invalid JSON response");
        }
      }
      if (opts.tolerate?.includes(res.status)) return null;
      throw new NeonBranchError(res.status, opts.operation, scrub(text || res.statusText));
    }
  }

  const get = async <T>(path: string, opts: RequestOptions): Promise<T> => (await request<T>("GET", path, opts)) as T;

  async function waitForOperations(ops: RawOperation[] | undefined, label: string): Promise<void> {
    for (const op of ops ?? []) {
      let status = op.status;
      const started = Date.now();
      let polls = 0;
      for (;;) {
        if (OP_FAILED.has(status)) throw new NeonBranchError(0, label, `operation ${op.id} ${status}`);
        if (OP_DONE.has(status)) break;
        const elapsed = Math.max(Date.now() - started, polls * pollIntervalMs);
        if (elapsed >= operationTimeoutMs) {
          throw new NeonBranchError(0, label, `operation ${op.id} timed out (last status ${scrub(status)})`);
        }
        await sleep(pollIntervalMs);
        polls++;
        const r = await get<{ operation?: RawOperation }>(`${projectPath}/operations/${encodeURIComponent(op.id)}`, {
          operation: `${label}:poll`,
        });
        status = r.operation?.status ?? status;
      }
    }
  }

  async function roleFor(branchId: string): Promise<string> {
    const cached = roleCache.get(branchId);
    if (cached) return cached;
    const r = await get<{ roles?: Array<{ name: string }> }>(`${projectPath}/branches/${branchId}/roles`, {
      operation: "listRoles",
    });
    const names = (r.roles ?? []).map((x) => x.name).filter((n) => typeof n === "string");
    const role = names.includes(PREFERRED_ROLE) ? PREFERRED_ROLE : names.find((n) => !isSystemRole(n));
    if (!role) throw new NeonBranchError(0, "listRoles", `no usable role on branch ${branchId}`);
    roleCache.set(branchId, role);
    return role;
  }

  return {
    async createBranch(opts) {
      assertBranchId(opts.parentId, "parent branch id");
      if (!opts.name || opts.name.length > 256) throw new NeonBranchError(0, "validate", "invalid branch name");
      const branch: Record<string, unknown> = { name: opts.name, parent_id: opts.parentId };
      if (opts.expiresAt) branch.expires_at = toRfc3339Seconds(opts.expiresAt);
      return runExclusive(projectId, async () => {
        const r = await request<MutationResponse>("POST", `${projectPath}/branches`, {
          operation: "createBranch",
          body: { branch, endpoints: [{ type: "read_write" }] },
        });
        if (!r?.branch?.id) throw new NeonBranchError(0, "createBranch", "response missing branch id");
        await waitForOperations(r.operations, "createBranch");
        return toInfo(r.branch);
      });
    },

    async connectionUri(branchId, databaseName, roleName) {
      assertBranchId(branchId);
      if (!databaseName) throw new NeonBranchError(0, "validate", "databaseName is required");
      const role = roleName ?? (await roleFor(branchId));
      const r = await get<{ uri?: string }>(`${projectPath}/connection_uri`, {
        operation: "connectionUri",
        query: { branch_id: branchId, database_name: databaseName, role_name: role, pooled: "false" },
      });
      if (!r.uri) throw new NeonBranchError(0, "connectionUri", "response missing uri");
      let host: string;
      try {
        host = new URL(r.uri).hostname;
      } catch {
        throw new NeonBranchError(0, "connectionUri", "response uri is not a valid URL");
      }
      if (host.includes("-pooler")) {
        throw new NeonBranchError(0, "connectionUri", "expected a direct (non-pooled) connection host");
      }
      return r.uri;
    },

    async resetFromParent(branchId, parentId) {
      assertBranchId(branchId);
      assertBranchId(parentId, "parent branch id");
      return runExclusive(projectId, async () => {
        const r = await request<MutationResponse>("POST", `${projectPath}/branches/${branchId}/restore`, {
          operation: "resetFromParent",
          body: { source_branch_id: parentId },
        });
        await waitForOperations(r?.operations, "resetFromParent");
      });
    },

    async deleteBranch(branchId) {
      assertBranchId(branchId);
      return runExclusive(projectId, async () => {
        const r = await request<MutationResponse>("DELETE", `${projectPath}/branches/${branchId}`, {
          operation: "deleteBranch",
          tolerate: [404],
        });
        roleCache.delete(branchId);
        if (r) await waitForOperations(r.operations, "deleteBranch");
      });
    },

    async listBranches() {
      const r = await get<{ branches?: RawBranch[] }>(`${projectPath}/branches`, { operation: "listBranches" });
      return (r.branches ?? []).map(toInfo);
    },

    async defaultBranchId() {
      const r = await get<{ branches?: RawBranch[] }>(`${projectPath}/branches`, { operation: "defaultBranchId" });
      const def = (r.branches ?? []).find((b) => b.default === true) ?? (r.branches ?? []).find((b) => b.primary === true);
      if (!def) throw new NeonBranchError(0, "defaultBranchId", "project has no default branch");
      return def.id;
    },
  };
}

export function neonBranchManagerFromEnv(
  env: Record<string, string | undefined> = process.env,
): NeonBranchManager {
  const apiKey = env.NEON_API_KEY;
  const projectId = env.NEON_PROJECT_ID;
  if (!apiKey) throw new NeonBranchError(0, "config", "NEON_API_KEY is not set");
  if (!projectId) throw new NeonBranchError(0, "config", "NEON_PROJECT_ID is not set");
  return createNeonBranchManager({ apiKey, projectId });
}
