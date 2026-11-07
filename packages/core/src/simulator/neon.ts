import { randomUUID } from 'node:crypto';
import { z } from 'zod';
const branchSchema = z.object({ id: z.string().regex(/^br-[a-z0-9-]+$/), project_id: z.string(), name: z.string(), parent_id: z.string().optional(), default: z.boolean(), protected: z.boolean().optional() });
export interface BranchOwnership { jobId: string; projectId: string; parentId: string; name: string; branchId?: string; createAttempts?: number; state: 'creating' | 'retryable' | 'ready' | 'delete_requested' | 'deleted' }
export interface BranchLedger {
  /** Durable exclusive per-job lock; each put must commit BEFORE it resolves (not deferred until callback returns). */
  withJobLock<T>(jobId: string, fn: (record: BranchOwnership | undefined, put: (record: BranchOwnership) => Promise<void>) => Promise<T>): Promise<T>;
}
export interface NeonApi { call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body?: unknown }> }
/** Fixed trusted origin; credentials and error response bodies never escape. No automatic mutation retries. */
export class NeonHttpApi implements NeonApi {
  constructor(private readonly apiKey: string) { if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('invalid_neon_key'); }
  async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    if (!/^\/projects\/[a-z0-9-]+\/branches(?:\/br-[a-z0-9-]+)?$/.test(path)) throw new Error('invalid_neon_path');
    try {
      const res = await fetch(`https://console.neon.tech/api/v2${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (![200, 201, 204, 404, 423, 503].includes(res.status)) { await res.body?.cancel(); throw new Error('neon_http_error'); }
      if ([204, 404, 423, 503].includes(res.status)) { await res.body?.cancel(); return { status: res.status }; }
      const reader = res.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      if (!reader) throw new Error('neon_invalid_response');
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1_000_000) { await reader.cancel(); throw new Error('neon_response_too_large'); } chunks.push(part.value); }
      return { status: res.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
    } catch { throw new Error('neon_request_failed'); }
  }
}
export class NeonBranchService {
  constructor(private readonly api: NeonApi, private readonly ledger: BranchLedger, private readonly projectId: string, private readonly seedBranchId: string) {
    if (!/^[a-z0-9-]{1,60}$/.test(projectId) || !/^br-[a-z0-9-]+$/.test(seedBranchId)) throw new Error('invalid_neon_config');
  }
  async createJobBranch(jobId: string): Promise<BranchOwnership> {
    if (!jobId || jobId.length > 128) throw new Error('invalid_job');
    return this.ledger.withJobLock(jobId, async (existing, put) => {
      if (existing) {
        this.assertRecord(existing, jobId);
        if (existing.state === 'ready') return existing;
        // An ambiguous POST is never repeated automatically, even after a crash.
        if (existing.state !== 'retryable') throw new Error('branch_requires_reconciliation');
        if ((existing.createAttempts ?? 1) >= 3) throw new Error('branch_retry_exhausted');
      }
      const record: BranchOwnership = { jobId, projectId: this.projectId, parentId: this.seedBranchId, name: existing?.name ?? `eval-job-${randomUUID()}`, state: 'creating', createAttempts: (existing?.createAttempts ?? 0) + 1 };
      await put(record);
      const response = await this.api.call('POST', this.base(), { branch: { name: record.name, parent_id: this.seedBranchId }, endpoints: [{ type: 'read_write' }] });
      if ([423, 503].includes(response.status)) {
        await put({ ...record, state: 'retryable' });
        throw new Error('branch_retryable_response');
      }
      if (response.status !== 201) throw new Error('neon_create_failed');
      const parsed = z.object({ branch: branchSchema }).safeParse(response.body);
      if (!parsed.success) throw new Error('neon_invalid_response');
      this.assertBranch(parsed.data.branch, record);
      const owned: BranchOwnership = { ...record, branchId: parsed.data.branch.id, state: 'ready' };
      await put(owned); return owned;
    });
  }
  async deleteJobBranch(jobId: string): Promise<{ state: 'deleted' | 'delete_requested' | 'absent' }> {
    return this.ledger.withJobLock(jobId, async (record, put) => {
      if (!record) return { state: 'absent' };
      this.assertRecord(record, jobId);
      if (record.state === 'deleted') return { state: 'deleted' };
      if (!record.branchId) throw new Error('branch_requires_reconciliation');
      const path = `${this.base()}/${record.branchId}`;
      const current = await this.api.call('GET', path);
      if (current.status === 404 || current.status === 204) { await put({ ...record, state: 'deleted' }); return { state: 'deleted' }; }
      if (current.status !== 200) throw new Error('neon_lookup_failed');
      const parsed = z.object({ branch: branchSchema }).safeParse(current.body);
      if (!parsed.success) throw new Error('neon_invalid_response');
      this.assertBranch(parsed.data.branch, record);
      // A prior DELETE may have been accepted or timed out after acceptance.
      // Observe until absence; never repeat an ambiguous non-idempotent mutation.
      if (record.state === 'delete_requested') return { state: 'delete_requested' };
      await put({ ...record, state: 'delete_requested' });
      const response = await this.api.call('DELETE', path);
      if ([423, 503].includes(response.status)) {
        await put({ ...record, state: 'ready' });
        throw new Error('branch_retryable_response');
      }
      if (![200, 204, 404].includes(response.status)) throw new Error('neon_delete_failed');
      // 200 means deletion was accepted; it is asynchronous, not proof of removal.
      const state = response.status === 200 ? 'delete_requested' : 'deleted';
      await put({ ...record, state }); return { state };
    });
  }
  private base() { return `/projects/${this.projectId}/branches`; }
  private assertRecord(r: BranchOwnership, jobId: string) {
    if (r.jobId !== jobId || r.projectId !== this.projectId || r.parentId !== this.seedBranchId || !/^eval-job-[a-f0-9-]{36}$/.test(r.name) || (r.branchId && !/^br-[a-z0-9-]+$/.test(r.branchId))) throw new Error('branch_ownership_mismatch');
  }
  private assertBranch(b: z.infer<typeof branchSchema>, r: BranchOwnership) {
    if (b.project_id !== this.projectId || b.parent_id !== this.seedBranchId || b.name !== r.name || b.id === this.seedBranchId || b.default || b.protected || (r.branchId && b.id !== r.branchId)) throw new Error('branch_ownership_mismatch');
  }
}
