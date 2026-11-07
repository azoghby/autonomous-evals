import { describe, expect, it, vi } from 'vitest';
import { executeSuite } from '../execute';
import { investigateTextRun } from '../investigate';
import { textRunForMonitoring } from '../monitoring';
import { evaluateObjectiveCheck } from '../objective';
import { makeSuite } from './fixtures';
import type { AgentTaskRunner } from '../../../agents/session-service';

describe('credential and unknown-state boundaries', () => {
  it('refuses credential-bearing target text before judge or persistence', async () => {
    const judge = vi.fn();
    const run = await executeSuite(makeSuite(), 'secret-response', { target: { send: async () => ({ ok: true, text: 'READY private-fixture-credential', latencyMs: 1 }) }, judge, evaluateObjective: evaluateObjectiveCheck, knownSecrets: ['private-fixture-credential'] });
    expect(judge).not.toHaveBeenCalled();
    expect(JSON.stringify(run)).not.toContain('private-fixture-credential');
    expect(run.executions.every(e => e.outcome === 'infrastructure_error' && e.responseText === null)).toBe(true);
  });
  it('reports unresolved coverage even when there are no product findings', async () => {
    const suite = makeSuite();
    const target = { send: async () => ({ ok: false as const, errorCode: 'timeout', message: 'discard', latencyMs: 1 }) };
    const deps = { target, judge: null, evaluateObjective: evaluateObjectiveCheck };
    const run = await executeSuite(suite, 'unknown-run', deps);
    const runner = { run: vi.fn() } as unknown as AgentTaskRunner;
    const investigation = await investigateTextRun({ job: { jobId: suite.jobId, customerId: 'fixture', environment: 'test', package: 'text_eval', quoteVersion: null, linkedRetestOf: null, isFixture: true }, suite, run }, { ...deps, runner });
    expect(investigation.findings).toEqual([]);
    expect(investigation.limitations.join(' ')).toContain('12 unresolved');
    expect(runner.run).not.toHaveBeenCalled();
    expect(textRunForMonitoring(suite, run, 'fixture-v2').checks.every(c => c.outcome === 'infrastructure_error')).toBe(true);
  });
  it('projects deterministic objective checks and rejects forged check identities', async () => {
    const suite = makeSuite();
    const run = await executeSuite(suite, 'observed', { target: { send: async () => ({ ok: true as const, text: 'READY', latencyMs: 1 }) }, judge: null, evaluateObjective: evaluateObjectiveCheck });
    const projection = textRunForMonitoring(suite, run, 'fixed');
    expect(projection.checks).toHaveLength(12);
    expect(projection.checks.every(c => c.outcome === 'passed' && c.evidenceIds.length === 1)).toBe(true);
    const forged = structuredClone(run); forged.executions[0]!.checks[0]!.checkId = 'S01.o2';
    expect(() => textRunForMonitoring(suite, forged, 'fixed')).toThrow('check identity');
  });
});
