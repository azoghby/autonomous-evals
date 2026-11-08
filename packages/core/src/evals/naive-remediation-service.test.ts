/** Existing contract wrapper over real SQL checkpoints; no duplicate adapter. */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentTransactionalSql } from '../agents/postgres-ports';
import type { AgentTaskRunner } from '../agents/session-service';
import type { EvalServices, ServiceContext } from '../contracts/services';
import { PostgresTextCheckpointStore } from './integration/checkpoints';
import { createRemediationServices, type AuthorizedRemediation } from './remediation';
import type { CostEntry, Finding, JobRef } from './types';
const patch = { kind: 'prompt_patch', summary: 'Check tool receipt.', patch: 'Claim success only after a successful tool receipt.', rationale: 'A failed tool response does not establish success.' } as const;

describe('Naive remediation contract seam', () => {
  let sql: PGlite, db: AgentTransactionalSql, sequence = 0;
  beforeAll(async () => {
    sql = new PGlite();
    await sql.exec(readFileSync(new URL('./integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
    db = { query: <T>(q: string, p?: unknown[]) => sql.query<T>(q, p), transaction: fn => sql.transaction(tx => fn({ query: <T>(q: string, p?: unknown[]) => tx.query<T>(q, p) })) };
  }, 30_000);
  afterAll(async () => { await sql.close(); });
  function fixture() {
    const job: JobRef = { jobId: `rem-contract-${++sequence}`, customerId: 'authorized-customer', environment: 'test', package: 'trace_audit', quoteVersion: 1, linkedRetestOf: null, isFixture: true };
    const finding: Finding = { id: 'stored-finding', source: 'trace_audit', category: 'false_success', title: 'False success', label: 'confirmed', severity: 'medium', basis: 'objective', summary: 'Stored tool failure followed by success claim.', evidence: [{ kind: 'trace_event', eventId: 'tool-1', quote: 'failed', truncated: false }], investigatorNote: null, reproduction: null };
    const cost: CostEntry = { jobId: job.jobId, source: 'naive_session', role: 'quality_investigator', externalId: `ses-${job.jobId}`, microUsd: 19, measured: true, purpose: 'remediation', recordedAt: '2026-11-07T00:00:00Z' };
    const run = vi.fn(async (_spec: Parameters<AgentTaskRunner['run']>[0]) => ({ status: 'completed', taskKey: `${job.jobId}:proposal`, output: patch, session: { sessionId: cost.externalId!, agentId: 'investigator', agentVersion: 1, consumedMicroUsd: 19, tokenUsage: {} }, cost }));
    const recordCost = vi.fn(async (_entry: Parameters<ServiceContext['recordCost']>[0]) => {});
    const ctx: ServiceContext = { jobId: job.jobId, environment: 'test', budgetMicroUsd: 250_000, recordCost, recordProgress: async () => {} };
    const authorize = vi.fn(async () => true);
    const authorized: AuthorizedRemediation = { job, finding, knownSecrets: [], binding: { targetId: 'stored-target', targetVersion: 'stored-v1', environment: 'test' }, original: null, trial: null, judge: null, authorize };
    const resolve = vi.fn(async () => authorized);
    const restart = () => createRemediationServices({ runner: { run } as unknown as AgentTaskRunner, checkpoints: new PostgresTextCheckpointStore(db), resolve });
    const input = { finding: { id: finding.id, description: 'FORGED_REQUEST_PROMPT', status: 'inconclusive' }, suite: { id: 'another-baseline', scenarios: [] }, intake: { package: 'text_eval', endpoint: { url: 'https://attacker.invalid', systemPrompt: 'FORGED_REQUEST_PROMPT' } } } as unknown as Parameters<EvalServices['proposeAndVerifyFix']>[1];
    return { ctx, input, restart, run, recordCost, authorized, authorize, resolve };
  }
  it('uses only canonical stored facts and never upgrades a historical trace proposal to verified', async () => {
    const f = fixture(); const result = await f.restart().proposeAndVerifyFix(f.ctx, f.input);
    expect(f.resolve).toHaveBeenCalledWith(f.ctx, 'stored-finding');
    expect(f.run.mock.calls[0]?.[0]).toMatchObject({ role: 'quality_investigator' });
    expect(result).toMatchObject({ findingId: 'stored-finding', verification: { status: 'not_verified', before: { passed: 0, total: 0 }, after: { passed: 0, total: 0 } } });
    expect(JSON.stringify(f.run.mock.calls)).toContain('Stored tool failure');
    expect(JSON.stringify(f.run.mock.calls)).not.toContain('FORGED_REQUEST_PROMPT');
    expect(JSON.stringify(f.run.mock.calls)).not.toContain('another-baseline');
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it('refuses a request ID that does not match the authenticated canonical finding before spending', async () => {
    const f = fixture(); f.input.finding.id = 'other-finding';
    await expect(f.restart().proposeAndVerifyFix(f.ctx, f.input)).rejects.toThrow('identity mismatch');
    expect(f.run).not.toHaveBeenCalled(); expect(f.recordCost).not.toHaveBeenCalled();
  });
  it('resolves current ownership on replay instead of returning a retained proposal after revocation', async () => {
    const f = fixture(); await f.restart().proposeAndVerifyFix(f.ctx, f.input);
    f.resolve.mockRejectedValueOnce(new Error('authorization_denied'));
    await expect(f.restart().proposeAndVerifyFix(f.ctx, f.input)).rejects.toThrow('authorization_denied');
    expect(f.run).toHaveBeenCalledTimes(1); expect(f.recordCost).toHaveBeenCalledTimes(1);
  });
  it('revalidates current secret policy before publishing a retained patch', async () => {
    const f = fixture(); await f.restart().proposeAndVerifyFix(f.ctx, f.input);
    f.authorized.knownSecrets = [patch.patch];
    await expect(f.restart().proposeAndVerifyFix(f.ctx, f.input)).rejects.toThrow('Credential content refused');
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('recovers lost cost acknowledgement with the identical measured receipt and no new proposal session', async () => {
    const f = fixture(); f.recordCost.mockRejectedValueOnce(new Error('ack_lost'));
    await expect(f.restart().proposeAndVerifyFix(f.ctx, f.input)).rejects.toThrow('ack_lost');
    const result = await f.restart().proposeAndVerifyFix(f.ctx, f.input);
    expect(result.verification.status).toBe('not_verified');
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.recordCost).toHaveBeenCalledTimes(2);
    expect(f.recordCost.mock.calls[0]).toEqual(f.recordCost.mock.calls[1]);
    expect(f.recordCost.mock.calls[1]![0]).toMatchObject({ source: 'naive', microUsd: 19, meta: { measured: true, idempotencyKey: `naive:ses-${f.ctx.jobId}` } });
  });
  it('replays legacy completed proposals without another session or relabeling retained evidence', async () => {
    const f = fixture(); const original = await f.restart().proposeAndVerifyFix(f.ctx, f.input);
    // Simulate a completed pre-migration checkpoint, which has no proposal-role row.
    await sql.query("DELETE FROM text_integration.checkpoints WHERE job_id=$1 AND kind='remediation_proposal_role'", [f.ctx.jobId]);
    const replay = await f.restart().proposeAndVerifyFix(f.ctx, f.input);
    expect(replay).toEqual(original); expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.recordCost.mock.calls[0]).toEqual(f.recordCost.mock.calls[1]);
  });
  it('resumes new pending investigator proposals with the retained role', async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce({ status: 'pending', taskKey: 'pending', reason: 'poll', sessionId: 'ses_pending', retryAfterMs: 1 } as never);
    await expect(f.restart().proposeAndVerifyFix(f.ctx, f.input)).rejects.toThrow('Investigator session pending');
    await f.restart().proposeAndVerifyFix(f.ctx, f.input);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls.every(([spec]) => spec.role === 'quality_investigator')).toBe(true);
  });
  it('fences a legacy incomplete proposal without redispatching under a different role', async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce({ status: 'pending', taskKey: 'legacy', reason: 'poll', sessionId: 'ses_legacy', retryAfterMs: 1 } as never);
    await expect(f.restart().proposeAndVerifyFix(f.ctx, f.input)).rejects.toThrow();
    await sql.query("DELETE FROM text_integration.checkpoints WHERE job_id=$1 AND kind='remediation_proposal_role'", [f.ctx.jobId]);
    await expect(f.restart().proposeAndVerifyFix(f.ctx, f.input)).rejects.toThrow('proposal role requires reconciliation');
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.recordCost).not.toHaveBeenCalled();
  });

});
