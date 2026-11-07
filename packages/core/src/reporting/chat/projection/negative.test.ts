import { describe, expect, it } from 'vitest';
import { createDurableProgressProjection } from './index.js';
import type { DurableProgressRead, ProgressProjectionPorts, ProjectionPlan } from './types.js';

const scope = { subjectId: 'alice', jobId: 'job-1' };
const time = '2026-11-07T20:00:00.000Z';
const digest = 'a'.repeat(64);
function fixture() {
  const key = { jobId: scope.jobId, kind: 'investigation', id: 'run-1', inputDigest: digest };
  const plan: ProjectionPlan = { scope: { ...scope }, environment: 'test', checkpoints: [
    { key: { ...key }, phase: 'investigating', format: 'text_investigation' },
  ], acquisitionTaskIds: [] };
  const read: DurableProgressRead = { scope: { ...scope }, observedAt: time,
    job: { jobId: scope.jobId, status: 'investigating', updatedAt: time },
    checkpoints: [{ key: { ...key }, record: { state: 'completed', value: { investigatorStatus: 'completed', findings: [], testDefects: [], reproductions: [] } } }],
    acquisition: [], costs: [], unknownCosts: true };
  let reads = 0;
  const ports: ProgressProjectionPorts = {
    referenceKey: 'synthetic-projection-hmac-key-32-bytes',
    access: { async authenticate() { return { subjectId: 'alice' }; }, async resolveAuthorizedJob(caller, jobId) {
      return caller.subjectId === 'alice' && jobId === scope.jobId ? { ...scope } : null;
    } },
    async resolve() { return plan; },
    reader: { async read() { reads++; return read; } },
  };
  return { ports, plan, read, reads: () => reads, project: () => createDurableProgressProjection(ports).project(scope) };
}
const unavailable = { code: 'invalid_snapshot', message: 'Persisted progress is unavailable or invalid.' };

describe('durable projection negative boundary', () => {
  it('rejects another authenticated subject before reading durable records', async () => {
    const f = fixture(); f.ports.access.authenticate = async () => ({ subjectId: 'bob' });
    await expect(f.project()).rejects.toMatchObject({ code: 'not_found' }); expect(f.reads()).toBe(0);
  });
  it('rejects another requested job before reading durable records', async () => {
    const f = fixture();
    await expect(createDurableProgressProjection(f.ports).read({ ...scope, jobId: 'job-2' })).rejects.toMatchObject({ code: 'not_found' });
    expect(f.reads()).toBe(0);
  });
  it('rejects resolver scope substitutions before reading', async () => {
    const f = fixture(); f.ports.access.resolveAuthorizedJob = async () => ({ ...scope, subjectId: 'bob' });
    await expect(f.project()).rejects.toMatchObject({ code: 'not_found' }); expect(f.reads()).toBe(0);
  });
  it('rechecks authorization on each direct projection', async () => {
    const f = fixture(); const projection = createDurableProgressProjection(f.ports);
    await projection.read(scope); f.ports.access.resolveAuthorizedJob = async () => null;
    await expect(projection.read(scope)).rejects.toMatchObject({ code: 'not_found' }); expect(f.reads()).toBe(1);
  });
  it('rejects an inventory for another user', async () => {
    const f = fixture(); f.plan.scope.subjectId = 'bob';
    await expect(f.project()).rejects.toMatchObject({ code: 'not_found' }); expect(f.reads()).toBe(0);
  });
  it.each(['subjectId', 'jobId'] as const)('rejects returned %s scope drift', async field => {
    const f = fixture(); f.read.scope[field] = 'other'; await expect(f.project()).rejects.toMatchObject(unavailable);
  });
  it('rejects a returned job from another tenant', async () => {
    const f = fixture(); f.read.job.jobId = 'other'; await expect(f.project()).rejects.toMatchObject(unavailable);
  });
  it('rejects checkpoint digest conflicts instead of accepting a different operation', async () => {
    const f = fixture(); f.read.checkpoints[0]!.key.inputDigest = 'b'.repeat(64);
    await expect(f.project()).rejects.toMatchObject(unavailable);
  });
  it('rejects checkpoint inventories crossing jobs before durable reads', async () => {
    const f = fixture(); f.plan.checkpoints[0]!.key.jobId = 'other';
    await expect(f.project()).rejects.toMatchObject(unavailable); expect(f.reads()).toBe(0);
  });
  it('rejects omitted checkpoint responses instead of silently treating them as complete', async () => {
    const f = fixture(); f.read.checkpoints = []; await expect(f.project()).rejects.toMatchObject(unavailable);
  });
  it('rejects duplicate checkpoint identities with conflicting digests', async () => {
    const f = fixture(); f.plan.checkpoints.push({ ...f.plan.checkpoints[0]!, key: { ...f.plan.checkpoints[0]!.key, inputDigest: 'b'.repeat(64) } });
    await expect(f.project()).rejects.toMatchObject(unavailable); expect(f.reads()).toBe(0);
  });
  it.each(['pending', 'ambiguous', 'missing'] as const)('refuses delivered with %s evidence', async state => {
    const f = fixture(); f.read.job.status = 'delivered';
    f.read.checkpoints[0]!.record = state === 'missing' ? null : { state };
    await expect(f.project()).rejects.toMatchObject(unavailable);
  });
  it('preserves an old durable watermark rather than making stale evidence current', async () => {
    const f = fixture(); f.read.observedAt = '2025-01-01T00:00:00.000Z'; f.read.job.updatedAt = f.read.observedAt;
    expect((await f.project()).snapshot.observedAt).toBe('2025-01-01T00:00:00.000Z');
  });
  it('rejects a job update after the consistent read watermark', async () => {
    const f = fixture(); f.read.job.updatedAt = '2026-11-07T20:00:00.001Z';
    await expect(f.project()).rejects.toMatchObject(unavailable);
  });
  it('rejects foreign cost rows and keeps the public error fixed', async () => {
    const f = fixture(); f.read.costs = [{ jobId: 'other', source: 'naive_session', role: null,
      externalId: 'session-1', purpose: 'postgres://admin:secret@private', microUsd: 10, measured: true, recordedAt: time }];
    await expect(f.project()).rejects.toMatchObject(unavailable);
  });
  it('rejects duplicate measured session costs instead of double counting', async () => {
    const f = fixture(); const cost = { jobId: scope.jobId, source: 'naive_session' as const, role: null,
      externalId: 'session-1', purpose: 'investigation', microUsd: 10, measured: true, recordedAt: time };
    f.read.costs = [cost, { ...cost }]; await expect(f.project()).rejects.toMatchObject(unavailable);
  });
  it('strips arbitrary phase payloads and cost metadata while keeping opaque references', async () => {
    const f = fixture(); const secret = 'synthetic-sensitive-customer-value'; f.ports.knownSecrets = [secret];
    f.read.checkpoints[0]!.record = { state: 'completed', value: { investigatorStatus: 'completed', findings: [], testDefects: [], reproductions: [], rawTrace: secret, targetUrl: 'https://customer.invalid/private', status: 'all tests passed' } };
    f.read.costs = [{ jobId: scope.jobId, source: 'naive_session', role: null, externalId: secret,
      purpose: secret, microUsd: 10, measured: true, recordedAt: time }];
    const result = await f.project(); const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(secret); expect(encoded).not.toContain('https://'); expect(encoded).not.toContain('all tests passed');
    expect(result.snapshot.costs[0]!.evidenceRef).toMatch(/^ev_[a-f0-9]{64}$/);
  });
  it('refuses a known secret that would survive in a public job ID', async () => {
    const f = fixture(); f.ports.knownSecrets = [scope.jobId]; await expect(f.project()).rejects.toMatchObject(unavailable);
  });
  it('masks raw durable reader errors without retaining their cause', async () => {
    const f = fixture(); f.ports.reader.read = async () => { throw new Error('postgres://admin:secret@internal'); };
    const error = await f.project().catch((e: unknown) => e);
    expect(error).toMatchObject(unavailable); expect(error).not.toHaveProperty('cause'); expect(String(error)).not.toContain('postgres');
  });
});
