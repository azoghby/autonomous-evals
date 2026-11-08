import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentSessionService } from '../../agents/session-service';
import { InMemoryAgentTaskStore, InMemoryBudgetLedger } from '../../agents/memory-ports';
import { NaiveCallError, type NaiveSessionSnapshot, type NaiveSessionsPort } from '../types';
import { advanceDataOrchestration, createDataCostCapture, type DataFreezePort, type DataOrchestrationPorts } from './orchestration';
import { createFileDataOperationLedger } from './operation-ledger';
import { createNaiveGenerationAdapter } from './adapters/generation';
import { fixtureJob, fixtureSpec, fixtureTask } from './adapters/fixtures';
import { freezeSuite } from '../text/freeze';
import type { TextScenario } from '../text/schema';
import type { EvaluationDataTask } from './acquisition';
const empty = { sources: [], cases: [] };
const context = { job: fixtureJob, versionLabel: 'fixture-v1', systemPrompt: null };
async function setup(ready = false) {
 const directory = await mkdtemp(join(tmpdir(), 'session-resume-'));
 let task: EvaluationDataTask | null = null;
 const ports: DataOrchestrationPorts = {
  operations: createFileDataOperationLedger(directory),
  acquisition: { store: {
   get: async () => structuredClone(task),
   insertIfAbsent: async value => { const inserted = !task; task ??= ready ? { ...fixtureTask(), requestHash: value.requestHash, decisions: [{ id: 'review', phase: 'expert', outcome: 'reviewed_sufficient', at: value.updatedAt }] } : { ...structuredClone(value), phase: 'generation' }; return { inserted, record: structuredClone(task) }; },
   compareAndSet: async (_id, revision, next) => { if (task?.revision !== revision) return null; task = structuredClone(next); return structuredClone(task); },
  }, discover: async () => ({ status: 'complete', data: empty }), generate: vi.fn(async () => ({ status: 'pending' as const })), expert: async () => ({ status: 'pending' }) },
  readReview: async () => ({ status: 'pending' }), freeze: vi.fn(async () => ({ status: 'pending' as const })), deliverCost: vi.fn(async () => {}),
 };
 return { ports, directory, close: () => rm(directory, { recursive: true, force: true }) };
}
describe('durable generation and freeze advancement', () => {
 it('keeps legacy pending generation fenced across restart', async () => {
  const h = await setup(); try {
   await advanceDataOrchestration(fixtureSpec, empty, context, h.ports);
   h.ports.operations = createFileDataOperationLedger(h.directory);
   expect((await advanceDataOrchestration(fixtureSpec, empty, context, h.ports)).status).toBe('reconciliation_required');
   expect(h.ports.acquisition.generate).toHaveBeenCalledTimes(1);
  } finally { await h.close(); }
 });
 it('reconciles the actual durable generation session and captures measured costs before completion', async () => {
  const h = await setup(); let snapshot: NaiveSessionSnapshot | null = null;
  const createSession = vi.fn<NaiveSessionsPort['createSession']>(async body => {
   snapshot = { id: 'generation-session', agentId: body.agent_id, agentVersion: 1, status: 'idle', stopReason: 'end_turn', stopCode: null, structuredOutput: { cases: [] }, budgetMicroUsd: body.budget_micro_usd, consumedMicroUsd: 17, tokenUsage: {}, metadata: body.metadata };
   throw new NaiveCallError('ambiguous', 'lost create acknowledgement');
  });
  const runner = new AgentSessionService({ naive: { createSession, getSession: async () => snapshot!, listAgentSessions: async () => ({ data: snapshot ? [snapshot] : [], nextCursor: null }) }, store: new InMemoryAgentTaskStore(), ledger: new InMemoryBudgetLedger(), directory: { commercial: { agentId: 'commercial' }, evaluation_engineer: { agentId: 'engineer' }, quality_investigator: { agentId: 'reviewer' }, company_operator: { agentId: 'operator' } }, budgetPeriodId: 'fixture', idempotencyNamespace: 'fixture', workerId: 'fixture', maxWaitMs: 1, clock: { now: () => new Date('2026-11-07T00:00:00Z') } });
  const generate = createNaiveGenerationAdapter({ runner, job: fixtureJob, sessionCapMicroUsd: 1000, jobCapMicroUsd: 5000, onMeasuredCost: createDataCostCapture(h.ports.operations) });
  h.ports.acquisition.generate = generate; h.ports.resumeGeneration = generate;
  try {
   expect((await advanceDataOrchestration(fixtureSpec, empty, context, h.ports)).status).toBe('reconciliation_required');
   h.ports.operations = createFileDataOperationLedger(h.directory);
   expect((await advanceDataOrchestration(fixtureSpec, empty, context, h.ports)).status).toBe('waiting_for_review');
   expect(createSession).toHaveBeenCalledTimes(1);
   expect(h.ports.deliverCost).toHaveBeenCalledWith(expect.objectContaining({ taskKey: expect.any(String), cost: expect.objectContaining({ measured: true, microUsd: 17, externalId: 'generation-session' }) }));
   const delivered = vi.mocked(h.ports.deliverCost).mock.calls[0]![0];
   expect(await h.ports.operations.get(delivered.operationKey)).toMatchObject({ state: 'complete' });
   expect(await h.ports.operations.get(`${delivered.operationKey}:cost`)).toMatchObject({ state: 'complete', result: delivered });
   await advanceDataOrchestration(fixtureSpec, empty, context, h.ports);
   expect(createSession).toHaveBeenCalledTimes(1);
   expect(vi.mocked(h.ports.deliverCost).mock.calls.every(([entry]) => entry.taskKey === delivered.taskKey)).toBe(true);
  } finally { await h.close(); }
 });
 it('fences freeze until explicit reconciliation and validates the resumed suite binding', async () => {
  const h = await setup(true); try {
   expect((await advanceDataOrchestration(fixtureSpec, empty, context, h.ports)).status).toBe('reconciliation_required');
   h.ports.operations = createFileDataOperationLedger(h.directory);
   await advanceDataOrchestration(fixtureSpec, empty, context, h.ports);
   expect(h.ports.freeze).toHaveBeenCalledTimes(1);
   let invalidReference = true;
   h.ports.resumeFreeze = vi.fn<DataFreezePort>(async ({ mapping }) => {
    const scenarios: TextScenario[] = Array.from({ length: 12 }, (_, i) => ({ id: `S${String(i + 1).padStart(2, '0')}`, title: 'Fixture', category: i < 4 ? 'ordinary' : i < 8 ? 'instruction_edge' : 'grounding_ambiguity', userMessage: 'Which format?', rationale: 'Fixture', severity: 'medium', objectiveChecks: [{ id: `S${String(i + 1).padStart(2, '0')}.o1`, kind: 'objective', description: 'Answer', spec: { type: 'min_chars', value: 1 } }], rubricChecks: [] }));
    return { status: 'complete', suite: freezeSuite({ schemaVersion: 'text_suite.v1', jobId: fixtureJob.jobId, versionLabel: context.versionLabel, frozenAt: '2026-11-07T00:00:00Z', systemPrompt: null, referenceText: invalidReference ? 'unbound reference' : mapping.designInput.referenceText, scenarios, review: { sessions: [], rejections: [], reductions: [] } }) };
   });
   expect((await advanceDataOrchestration(fixtureSpec, empty, context, h.ports)).status).toBe('reconciliation_required');
   const freezeKey = vi.mocked(h.ports.resumeFreeze).mock.calls[0]![0].operationKey;
   expect(await h.ports.operations.get(freezeKey)).toMatchObject({ state: 'pending' });
   invalidReference = false;
   expect((await advanceDataOrchestration(fixtureSpec, empty, context, h.ports)).status).toBe('ready');
   expect((await advanceDataOrchestration(fixtureSpec, empty, context, h.ports)).status).toBe('ready');
   expect(h.ports.resumeFreeze).toHaveBeenCalledTimes(2);
  } finally { await h.close(); }
 });
});
