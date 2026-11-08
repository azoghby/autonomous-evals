import { z } from 'zod';
import type { BranchOwnership } from './neon';

export type NeonConnectionErrorCode = 'invalid_neon_connection_config' | 'branch_not_owned' |
  'branch_ownership_mismatch' | 'branch_not_ready' | 'neon_connection_invalid_response' |
  'neon_connection_request_failed' | 'neon_connection_timeout' | 'neon_connection_http_error';
/** Safe codes only: never attach provider bodies, URLs, credentials or original causes. */
export class NeonConnectionError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: NeonConnectionErrorCode) {
    super(code); this.name = 'NeonConnectionError';
    this.retryable = ['branch_not_ready', 'neon_connection_request_failed', 'neon_connection_timeout'].includes(code);
  }
}
export interface NeonConnectionConfig {
  projectId: string;
  seedBranchId: string;
  databaseName: string;
  roleName: string;
  apiKey: string;
  /** Trusted durable lookup, never supplied by a customer/model. */
  findOwnedBranch(branchId: string): Promise<BranchOwnership | undefined>;
  /** Trusted test transport; production should use the default native fetch. */
  fetch?: typeof globalThis.fetch;
  /** May lower the hard 30 second / 1 MB limits. */
  timeoutMs?: number;
  maxResponseBytes?: number;
}
const id = z.string().regex(/^[a-z0-9-]{1,60}$/);
const branchId = id.refine(v => v.startsWith('br-'));
const recordSchema = z.object({
  jobId: z.string().min(1).max(128), projectId: id, parentId: branchId,
  name: z.string().regex(/^eval-job-[a-f0-9-]{36}$/), branchId,
  state: z.literal('ready'),
});
const branchSchema = z.object({ branch: z.object({
  id: branchId, project_id: id, parent_id: branchId, name: z.string(),
  default: z.boolean(), protected: z.boolean(), current_state: z.string(), pending_state: z.string().optional(),
}) });
const endpointsSchema = z.object({ endpoints: z.array(z.object({
  id: id.refine(v => v.startsWith('ep-')), project_id: id, branch_id: branchId,
  host: z.string(), type: z.enum(['read_write', 'read_only']), current_state: z.string(),
  pending_state: z.string().optional(), disabled: z.boolean(),
})).max(100) });
function fail(code: NeonConnectionErrorCode): never { throw new NeonConnectionError(code); }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail('neon_connection_invalid_response');
}
function sameRecord(a: z.infer<typeof recordSchema>, b: z.infer<typeof recordSchema>) {
  return a.jobId === b.jobId && a.projectId === b.projectId && a.parentId === b.parentId &&
    a.name === b.name && a.branchId === b.branchId;
}

/** Read-only, one readiness observation per invocation; durable Workflow owns retries/backoff. */
export function createNeonConnectionResolver(config: NeonConnectionConfig): (owned: BranchOwnership) => Promise<string> {
  // Capture trusted configuration once; later mutations of the input cannot redirect requests.
  const { projectId, seedBranchId, databaseName, roleName, apiKey, findOwnedBranch } = config;
  const transport = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxBytes = config.maxResponseBytes ?? 1_000_000;
  const sqlName = (v: string) => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 63 && !/[\u0000-\u001f\u007f]/.test(v);
  if (!id.safeParse(projectId).success || !branchId.safeParse(seedBranchId).success ||
      !sqlName(databaseName) || !sqlName(roleName) || typeof apiKey !== 'string' ||
      !/^[\x21-\x7e]{1,4096}$/.test(apiKey) || typeof findOwnedBranch !== 'function' || typeof transport !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000) fail('invalid_neon_connection_config');

  return async owned => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new NeonConnectionError('neon_connection_timeout')); }, timeoutMs);
    });
    async function get(path: string): Promise<unknown> {
      controller.signal.throwIfAborted();
      const response = await transport(`https://console.neon.tech/api/v2/projects/${projectId}${path}`, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      if (controller.signal.aborted || response.redirected || response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        if ([423, 429, 503].includes(response.status)) fail('branch_not_ready');
        fail('neon_connection_http_error');
      }
      const reader = response.body?.getReader();
      if (!reader) fail('neon_connection_invalid_response');
      const cancelReader = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancelReader, { once: true });
      let size = 0; const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          controller.signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maxBytes) fail('neon_connection_invalid_response');
          chunks.push(part.value);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
        catch { return fail('neon_connection_invalid_response'); }
      } finally { controller.signal.removeEventListener('abort', cancelReader); cancelReader(); }
    }
    async function resolve(): Promise<string> {
      const candidate = recordSchema.safeParse(owned);
      if (!candidate.success) fail('branch_not_owned');
      const expected = candidate.data;
      if (expected.projectId !== projectId || expected.parentId !== seedBranchId || expected.branchId === seedBranchId) fail('branch_ownership_mismatch');
      async function checkLedger() {
        controller.signal.throwIfAborted();
        const stored = recordSchema.safeParse(await findOwnedBranch(expected.branchId));
        controller.signal.throwIfAborted();
        if (!stored.success || !sameRecord(stored.data, expected)) fail('branch_not_owned');
      }
      await checkLedger();
      const base = `/branches/${expected.branchId}`;
      const { branch } = parse(branchSchema, await get(base));
      if (branch.id !== expected.branchId || branch.project_id !== projectId || branch.parent_id !== seedBranchId ||
          branch.name !== expected.name || branch.id === seedBranchId || branch.default || branch.protected) fail('branch_ownership_mismatch');
      if (branch.current_state !== 'ready' || branch.pending_state !== undefined) fail('branch_not_ready');
      const { endpoints } = parse(endpointsSchema, await get(`${base}/endpoints`));
      if (endpoints.some(e => e.project_id !== projectId || e.branch_id !== expected.branchId)) fail('branch_ownership_mismatch');
      const writers = endpoints.filter(e => e.type === 'read_write');
      if (!writers.length) fail('branch_not_ready');
      if (writers.length !== 1) fail('neon_connection_invalid_response');
      const endpoint = writers[0]!;
      // Idle is suspended and connectable via Neon's on-demand activation; init is not ready.
      if (!['active', 'idle'].includes(endpoint.current_state) || endpoint.pending_state !== undefined || endpoint.disabled) fail('branch_not_ready');
      if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.neon\.tech$/.test(endpoint.host) ||
          endpoint.host.split('.')[0] !== endpoint.id) fail('neon_connection_invalid_response');
      const query = new URLSearchParams({ branch_id: expected.branchId, endpoint_id: endpoint.id,
        database_name: databaseName, role_name: roleName, pooled: 'false' });
      const { uri } = parse(z.object({ uri: z.string().min(1).max(16_384) }), await get(`/connection_uri?${query}`));
      // Only direct URIs; reject libpq routing overrides even when the primary host looks right.
      let url: URL;
      try { url = new URL(uri); } catch { return fail('neon_connection_invalid_response'); }
      try {
        const params = [...url.searchParams];
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== endpoint.host ||
            (url.port !== '' && url.port !== '5432') || url.hash || !url.password || /[\s\\]/.test(uri) ||
            decodeURIComponent(url.username) !== roleName || decodeURIComponent(url.pathname.slice(1)) !== databaseName ||
            params.some(([key, value]) => !((key === 'sslmode' && ['require', 'verify-ca', 'verify-full'].includes(value)) ||
              (key === 'channel_binding' && value === 'require'))) ||
            new Set(params.map(([key]) => key)).size !== params.length || !url.searchParams.has('sslmode')) fail('neon_connection_invalid_response');
      } catch { return fail('neon_connection_invalid_response'); }
      await checkLedger();
      return uri;
    }
    try { return await Promise.race([resolve(), deadline]); }
    catch (error) {
      if (controller.signal.aborted) fail('neon_connection_timeout');
      if (error instanceof NeonConnectionError) throw error;
      fail('neon_connection_request_failed');
    } finally { clearTimeout(timer); controller.abort(); }
  };
}
