// All credentials are synthetic strings; all provider behavior is in-process fake code.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { FileBackedPorts } from '../agents/file-ports';
import { AgentSessionService, type AgentTaskRunner, type AgentTaskSpec } from '../agents/session-service';
import { fixtureJob, harness } from '../agents/__tests__/fakes';
import { NaiveCallError, type CostEntry, type Finding } from '../evals/types';
import type { AgentTransactionalSql } from '../agents/postgres-ports';
import type { ServiceContext } from '../contracts/services';
import { PostgresTextCheckpointStore } from '../evals/integration/checkpoints';
import { createRemediationServices, type AuthorizedRemediation, type Patch } from '../evals/remediation';
import { createTrackBServices } from '../evals/service-adapter';

const opaque = 'rotation-fixture-"opaque\\value';
const cost = (jobId: string, purpose = 'remediation'): CostEntry => ({ jobId, source: 'naive_session', role: 'evaluation_engineer', externalId: 'session-fixture', purpose, microUsd: 7, measured: true, recordedAt: '2026-11-07T20:00:00.000Z' });
const context = (jobId: string): ServiceContext => ({ jobId, environment: 'test', budgetMicroUsd: 100000, recordCost: vi.fn(async () => {}), recordProgress: async () => {} });
const finding: Finding = { id: 'F1', source: 'trace_audit', category: 'instruction_violation', title: 'Marker absent', label: 'confirmed', severity: 'medium', basis: 'objective', summary: 'Stored evidence.', evidence: [{ kind: 'check', checkId: 'C1', detail: 'Missing marker.' }], investigatorNote: null, reproduction: null };

describe('ACCEPTANCE: current policy at persisted artifact consumption', () => {
  it('blocks an encoded SQL proposal after restart without engineer rerun or checkpoint mutation', async () => {
    const f = await remediationFixture({ ...basePatch, rationale: opaque });
    await f.call();
    const before = await f.rows();
    f.authorized.knownSecrets = ['unrelated-current-value'];
    expect((await f.call()).remediation.verification.status).toBe('not_verified');
    f.authorized.knownSecrets = [opaque];
    await expect(f.call()).rejects.toMatchObject({ code: 'needs_operator', message: 'Credential content refused.' });
    expect(f.run).toHaveBeenCalledOnce();
    expect(await f.rows()).toEqual(before);
    expect(JSON.stringify(before)).toContain(JSON.stringify(opaque).slice(1, -1));
  });

  it('re-screens a file-persisted operator result before report export after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rotation-report-'));
    try {
      const file = join(dir, 'tasks.json');
      const ports = new FileBackedPorts(file);
      const h = harness(() => ({ structuredOutput: { executive_summary: opaque, finding_notes: [], recommended_next_steps: [], retest_recommended: false } }), ports);
      let current: string[] = [];
      const ctx = context('report-rotation');
      const input = { intake: { package: 'trace_audit' as const, trace: '[]', authorizedToTest: true as const }, findings: [] };
      const service = (runner: AgentTaskRunner) => createTrackBServices({ runner, resolveJob: async () => ({ customerId: 'fixture-customer', package: 'trace_audit', isFixture: true, linkedRetestOf: null, quoteVersion: null }), resolveKnownSecrets: async () => current });
      const first = await service(h.service).renderReport(ctx, input);
      expect(first.summary).toBe(opaque);
      const before = await readFile(file, 'utf8');
      current = ['unrelated-current-value'];
      const reopened = new FileBackedPorts(file);
      const restarted = new AgentSessionService({ ...h.deps, ...reopened });
      const get = vi.spyOn(h.naive, 'getSession');
      expect((await service(restarted).renderReport(ctx, input)).summary).toBe(opaque);
      current = [opaque];
      await expect(service(restarted).renderReport(ctx, input)).rejects.toMatchObject({ code: 'rejected_input', message: 'Credential content refused' });
      expect(get).not.toHaveBeenCalled();
      expect(h.naive.createCalls).toHaveLength(1);
      expect(await readFile(file, 'utf8')).toBe(before);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

const basePatch: Patch = { kind: 'other', summary: 'Proposal only', patch: 'Review the bounded change.', rationale: 'Trace evidence cannot prove an applied fix.' };
let engine: PGlite;
let db: AgentTransactionalSql;
let seq = 0;
beforeAll(async () => {
  engine = new PGlite();
  await engine.exec(readFileSync(new URL('../evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
  db = { query: <T>(sql: string, params?: unknown[]) => engine.query<T>(sql, params), transaction: fn => engine.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })) };
}, 30000);
afterAll(async () => { await engine.close(); });
async function remediationFixture(patch: Patch, purpose?: string) {
  const job = fixtureJob({ jobId: `rotation-remediation-${++seq}` });
  const ctx = context(job.jobId);
  const run = vi.fn(async () => ({ status: 'completed', taskKey: 'fixture', output: patch, session: { sessionId: 'session-fixture', agentId: 'engineer', agentVersion: 1, consumedMicroUsd: 7, tokenUsage: {} }, cost: cost(job.jobId, purpose) }));
  const authorized: AuthorizedRemediation = { job, finding, knownSecrets: [], binding: { targetId: 'fixture', targetVersion: 'v1', environment: 'test' }, original: null, trial: null, judge: null, authorize: vi.fn(async () => true) };
  const call = () => createRemediationServices({ runner: { run } as unknown as AgentTaskRunner, checkpoints: new PostgresTextCheckpointStore(db), resolve: async () => authorized }).proposeAndVerifyFixDetailed(ctx, { findingId: finding.id });
  const rows = async () => (await db.query('SELECT kind, id, state, value FROM text_integration.checkpoints WHERE job_id=$1 ORDER BY kind,id', [job.jobId])).rows;
  return { ctx, run, authorized, call, rows };
}

describe('REGRESSION: current policy before persisted cost delivery', () => {
  it('ROT-1: rotated SQL proposal cost metadata is refused before recordCost and report export', async () => {
    const f = await remediationFixture(basePatch, opaque);
    await f.call();
    const before = await f.rows();
    const recordCost = vi.mocked(f.ctx.recordCost);
    recordCost.mockClear();
    f.authorized.knownSecrets = [opaque];
    // Current secret policy refuses persisted metadata before replay reaches the sink.
    await expect(f.call()).rejects.toThrow();
    expect(recordCost).not.toHaveBeenCalled();
    expect(await f.rows()).toEqual(before);
    expect(f.run).toHaveBeenCalledOnce();
    // The report layer independently refuses the same persisted cost metadata.
    const report = createTrackBServices({ runner: { run: f.run } as unknown as AgentTaskRunner,
      operatorSummary: false,
      resolveJob: async () => f.authorized.job,
      resolveKnownSecrets: async () => [opaque],
      listJobCosts: async () => {
        const saved = (await db.query<{ value: CostEntry }>(
          'SELECT value FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2',
          [f.ctx.jobId, 'remediation_cost'])).rows;
        return saved.map(r => r.value);
      },
    });
    await expect(report.renderReport(f.ctx, { intake: { package: 'trace_audit', trace: '[]', authorizedToTest: true }, findings: [] }))
      .rejects.toMatchObject({ code: 'rejected_input', message: 'Credential content refused' });
  });

});

describe('REGRESSION: current policy before durable request redispatch', () => {
  it.each(['ambiguous', 'rate_limited'] as const)('ROT-2: file-backed %s recovery refuses a now-secret prompt and retains unknown spend', async kind => {
    const dir = await mkdtemp(join(tmpdir(), `rotation-resume-${kind}-`));
    try {
      const file = join(dir, 'tasks.json');
      const ports = new FileBackedPorts(file);
      const h = harness(() => ({ structuredOutput: { answer: 'safe output' } }), ports);
      const spec: AgentTaskSpec<{ answer: string }> = { job: fixtureJob(), role: 'quality_investigator', purpose: 'rotation_resume', message: `Evidence ${opaque}`, output: { name: 'out', schema: z.object({ answer: z.string() }) }, budgetMicroUsd: 100000 };
      h.naive.createFailures.set(0, { error: new NaiveCallError(kind, 'synthetic failure'), createdAnyway: false });
      expect((await h.service.run(spec)).status).toBe('pending');
      const restarted = new AgentSessionService({ ...h.deps, ...new FileBackedPorts(file), workerId: 'restarted' });
      const before = JSON.parse(await readFile(file, 'utf8'));
      expect(await restarted.run({ ...spec, knownSecrets: [opaque] })).toMatchObject({ status: 'needs_operator', code: 'credential_in_prompt' });
      expect(h.naive.createCalls).toHaveLength(1);
      const after = JSON.parse(await readFile(file, 'utf8'));
      expect(Object.values(before.reservations)).toMatchObject([{ settledMicroUsd: null }]);
      expect(after.reservations).toEqual(before.reservations);
      const taskKey = Object.keys(before.tasks)[0]!;
      expect(after.tasks[taskKey].requestBody).toEqual(before.tasks[taskKey].requestBody);
      expect(after.tasks[taskKey].idempotencyKey).toBe(before.tasks[taskKey].idempotencyKey);
      const saved = await restarted.run({ ...spec, knownSecrets: [opaque] });
      expect(saved).toMatchObject({ status: 'needs_operator', code: 'credential_in_prompt' });
      expect(JSON.stringify(after)).toContain(JSON.stringify(spec.message).slice(1, -1));
      // New-attempt control proves the same policy rejects this prompt on the fresh path.
      expect(await restarted.run({ ...spec, attempt: 2, knownSecrets: [opaque] })).toMatchObject({ status: 'failed', code: 'credential_in_prompt' });
      expect(h.naive.createCalls).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
