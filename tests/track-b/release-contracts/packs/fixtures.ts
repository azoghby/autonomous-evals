import { vi } from 'vitest';
import { makeSuite } from '../src/evals/text/__tests__/fixtures';
import { appendRedTeamToSuite } from '../src/redteam/select';
import { Suite, type IntakeInput } from '../src/contracts/index';
import type { SuiteRun } from '../src/evals/text/schema';
import type { RichRunArtifact } from '../src/monitoring/composition';
export const frozen = makeSuite({ jobId: '11111111-1111-4111-8111-111111111111' });
export const time = '2026-11-07T20:00:00.000Z';
export const intake: IntakeInput = { package: 'text_eval', authorizedToTest: true,
  endpoint: { url: 'https://local-fixture.invalid/v1', model: 'fixture', systemPrompt: 'Follow explicit instructions.' } };
const base = Suite.parse({ jobId: frozen.jobId, frozenAt: time, scenarios: frozen.scenarios.map(s => ({
  id: s.id, title: s.title, category: s.category, input: s.userMessage,
  checks: s.objectiveChecks.map(c => ({ kind: c.kind, description: c.description, spec: c.spec })),
})) });
export const appended = appendRedTeamToSuite(base, intake);
export const ids = appended.scenarios.map(s => s.id);
export const packIds = ids.filter(id => id.startsWith('rt_'));
export const ctx = { jobId: frozen.jobId, environment: 'test' as const, budgetMicroUsd: 0,
  recordCost: vi.fn(async () => {}), recordProgress: vi.fn(async () => {}) };
export function run(): SuiteRun {
  return { schemaVersion: 'text_run.v1', jobId: frozen.jobId, suiteDigest: frozen.digest,
    versionLabel: frozen.versionLabel, runId: 'run-local', startedAt: time, completedAt: time,
    executions: frozen.scenarios.map(s => ({ scenarioId: s.id, runId: 'run-local', attempt: 'initial', outcome: 'completed',
      target: { ok: true, errorCode: null, latencyMs: 0 }, responseText: 'READY', responseClipped: false,
      startedAt: time, completedAt: time, checks: s.objectiveChecks.map(c => ({ checkId: c.id, kind: 'objective', status: 'pass',
        detail: 'Synthetic local observation.', evidenceQuotes: ['READY'], reason: null })) })) };
}
export function artifact(): RichRunArtifact {
  return { kind: 'text', suite: frozen, run: run(), investigation: {}, limitations: ['Local synthetic transport; no provider validation.'], costs: [], unknownCosts: ['All provider costs unknown.'] };
}

import type { ProgressProjectionPorts, ProjectionPlan, DurableProgressRead } from '../src/reporting/chat/projection/types';
import type { ReportInput } from '../src/reporting/render';
export function progressFixture() {
  const scope = { subjectId: 'local-subject', jobId: frozen.jobId };
  const key = { jobId: frozen.jobId, kind: 'run_result', id: 'run-local', inputDigest: 'a'.repeat(64) };
  const plan: ProjectionPlan = { scope, environment: 'test', acquisitionTaskIds: [], checkpoints: [{ key,
    phase: 'running', format: 'text_run', runId: 'run-local', suiteDigest: frozen.digest, scenarioIds: frozen.scenarios.map(s => s.id) }] };
  const read: DurableProgressRead = { scope, observedAt: time, job: { jobId: frozen.jobId, status: 'delivered', updatedAt: time },
    checkpoints: [{ key, record: { state: 'completed', value: { environment: 'test', run: run() } } }],
    acquisition: [], costs: [], unknownCosts: true };
  const ports: ProgressProjectionPorts = { referenceKey: 'synthetic-local-reference-key-32-bytes',
    access: { authenticate: async () => ({ subjectId: scope.subjectId }), resolveAuthorizedJob: async () => scope },
    resolve: async () => plan, reader: { read: vi.fn(async () => read) } };
  return { scope, plan, read, ports };
}
export function reportInput(): ReportInput {
  return { job: { jobId: frozen.jobId, customerId: 'local', environment: 'test', package: 'text_eval', isFixture: true,
    quoteVersion: null, linkedRetestOf: null }, generatedAt: time, findings: [], limitations: ['Appended pack evidence unavailable.'],
    operatorSummary: null, costs: null, includeHtml: true,
    details: { authorizedScenarioIds: ids, executedScenarioIds: frozen.scenarios.map(s => s.id) } };
}
