/**
 * Judge usage and monitoring outcomes versus shared cost and finding contracts. Injected fakes only.
 */
import { describe, expect, it } from 'vitest';
import { CostEntry, FindingStatus } from '../contracts/index';
import type { RunResult } from '../contracts/services';
import { createGatewayJudge, type JudgeUsage } from '../judges/gateway.js';
import { MonitoringRun, compareMonitoringRuns } from '../monitoring/index.js';

const jobId = '33333333-3333-4333-8333-333333333333';

/** The only mapping available without changing Track A: known tokens go in meta; unknown money cannot be null. */
const judgeUsageToCost = (usage: JudgeUsage) => ({
  jobId, source: usage.source, agent: 'judge' as const,
  microUsd: usage.costMicroUsd ?? 0,
  meta: { operationId: usage.operationId, model: usage.model, providerResponseId: usage.providerResponseId, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costKnown: usage.costMicroUsd !== null, result: usage.result },
});

describe('judge usage', () => {
  const usage: JudgeUsage = { operationId: 'op-1', source: 'ai_gateway', model: 'm', providerResponseId: 'resp-1', promptTokens: 10, completionTokens: 5, costMicroUsd: null, result: 'received' };

  it('maps into a valid CostEntry with source ai_gateway and agent judge, never the Naive source', () => {
    const entry = CostEntry.parse(judgeUsageToCost(usage));
    expect(entry.source).toBe('ai_gateway');
    expect(entry.agent).toBe('judge');
  });

  it('KNOWN GAP: unknown judge cost (null) is stored as 0 with meta.costKnown=false, which the schema cannot enforce as unknown', () => {
    const mapped = judgeUsageToCost(usage);
    expect(mapped.microUsd).toBe(0);
    expect(mapped.meta.costKnown).toBe(false);
    expect(CostEntry.safeParse({ ...mapped, microUsd: usage.costMicroUsd }).success).toBe(false);
    // A consumer summing microUsd would under-report; budget code must also read meta.costKnown.
  });

  it('records gateway usage for a real verdict through the injected adapter and maps verdict labels onto finding statuses', async () => {
    const recorded: JudgeUsage[] = [];
    const verdict = { outcome: 'rubric_concern', explanation: 'Dismissive.', evidenceQuotes: ['Go away.'] };
    const judge = createGatewayJudge({
      model: 'configured/model', token: async () => 'test-token', authorize: async () => {}, recordUsage: async (u) => { recorded.push(u); },
      fetch: async () => new Response(JSON.stringify({ id: 'gen-1', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } })),
    });
    const result = await judge({ operationId: 'op-2', rubric: 'Be polite', response: 'Go away.' });
    expect(FindingStatus.options).toContain(result.outcome); // rubric_concern is a shared finding status
    expect(recorded).toHaveLength(1);
    expect(CostEntry.parse(judgeUsageToCost(recorded[0]!)).meta).toMatchObject({ costKnown: false, promptTokens: 20, completionTokens: 10 });
    // 'passed' is a verdict but deliberately not a finding status: it produces no finding.
    expect(FindingStatus.safeParse('passed').success).toBe(false);
  });
});

describe('monitoring outcomes versus shared types', () => {
  const run = (runId: string, outcomes: Array<'passed' | 'failed' | 'inconclusive' | 'infrastructure_error'>) => MonitoringRun.parse({
    jobId: 'job', runId, suiteDigest: 'a'.repeat(64), targetVersion: 'v1',
    checks: outcomes.map((outcome, index) => ({ scenarioId: `s${index}`, checkId: 'c', outcome, evidenceIds: outcome === 'passed' || outcome === 'failed' ? [`e${index}`] : [] })),
  });

  it('keeps four outcomes internally and compares frozen-suite runs deterministically', () => {
    const baseline = run('base', ['passed', 'passed', 'passed', 'passed']);
    const current = run('now', ['passed', 'failed', 'inconclusive', 'infrastructure_error']);
    expect(() => compareMonitoringRuns(baseline, current)).not.toThrow();
  });

  it('KNOWN GAP: shared finding status has three values and RunResult one boolean, so monitoring outcomes cannot be exported without loss', () => {
    expect(FindingStatus.options).toEqual(['confirmed', 'rubric_concern', 'inconclusive']);
    const monitoring = ['passed', 'failed', 'inconclusive', 'infrastructure_error'];
    const sample: RunResult['results'][number] = { scenarioId: 's', passed: false, detail: '' };
    expect(Object.keys(sample)).not.toContain('outcome');
    expect(monitoring).toHaveLength(4);
    expect(FindingStatus.options).not.toContain('infrastructure_error');
  });
});
