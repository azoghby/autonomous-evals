import { vi } from 'vitest';
import {freezeSuite} from '@ae/core/evals/text/freeze';
import type {FrozenTextSuite,SuiteRun,CheckStatus} from '@ae/core/evals/text/schema';
export const suite: FrozenTextSuite = freezeSuite({ schemaVersion: 'text_suite.v1', jobId: '00000000-0000-0000-0000-000000000001', versionLabel: 'reviewed', frozenAt: '2026-11-07T20:00:00Z', systemPrompt: null, referenceText: null,
  review: { sessions: [], rejections: [], reductions: [] },
  scenarios: Array.from({ length: 12 }, (_, i) => { const id = `S${String(i + 1).padStart(2, '0')}`; return {
    id, title: `Local fixture ${i}`, category: i < 4 ? 'ordinary' as const : i < 8 ? 'instruction_edge' as const : 'grounding_ambiguity' as const,
    userMessage: 'The response must contain the literal "READY".', rationale: 'Local explicit constraint fixture.', severity: 'low' as const,
    objectiveChecks: [{ id: `${id}.o1`, kind: 'objective' as const, description: 'Required marker', spec: { type: 'contains' as const, value: 'READY', case_sensitive: true } }],
    rubricChecks: [{ id: `${id}.r1`, kind: 'rubric' as const, description: 'Factual assessment', rubric: 'Judge correctness against reference.', assessesFactualCorrectness: true, requiresReference: true as const }],
  }; }),
});
const request = { operationId: 'local-operation', baselineVersion: 'v1', currentVersion: 'v2', mode: 'comparison' as const };
const ctx = { jobId: suite.jobId, environment: 'test' as const, budgetMicroUsd: 1000, recordCost: vi.fn(async () => {}), recordProgress: vi.fn(async () => {}) };
export function artifact(version: string, operationId: string) {
  const statuses: CheckStatus[] = version === 'v1' ? ['pass', 'fail', 'pass', 'pass', 'pass'] : ['fail', 'pass', 'inconclusive', 'error', 'pass'];
  const run: SuiteRun = { schemaVersion: 'text_run.v1', jobId: suite.jobId, suiteDigest: suite.digest, versionLabel: suite.versionLabel, runId: operationId,
    startedAt: '2026-11-07T20:00:00Z', completedAt: '2026-11-07T20:00:01Z', executions: suite.scenarios.map((s, i) => ({
      scenarioId: s.id, runId: operationId, attempt: 'initial', outcome: i === 4 && version === 'v2' ? 'infrastructure_error' : 'completed',
      target: { ok: !(i === 4 && version === 'v2'), errorCode: i === 4 && version === 'v2' ? 'timeout' : null, latencyMs: 1 },
      responseText: 'READY', responseClipped: false, startedAt: '2026-11-07T20:00:00Z', completedAt: '2026-11-07T20:00:01Z',
      checks: [{ checkId: `${s.id}.o1`, kind: 'objective', status: statuses[i] ?? 'pass', detail: 'Local fixture result.', evidenceQuotes: ['READY'], reason: i === 2 && version === 'v2' ? 'judge_unavailable' : i === 3 && version === 'v2' ? 'check_error' : null },
        { checkId: `${s.id}.r1`, kind: 'rubric', status: 'not_assessed', detail: 'No reference.', evidenceQuotes: [], reason: 'no_reference' }],
    })) };
  return { kind: 'text' as const, suite, run, investigation: { findings: [], fixtureLabel: 'local-only' }, limitations: ['Local fixture evidence only.'],
    costs: [{ id: `local-${version}`, source: 'fixture-measured', microUsd: version === 'v1' ? 7 : 11, measured: true as const }], unknownCosts: ['customer provider usage unknown', 'hosting unknown'] };
}
