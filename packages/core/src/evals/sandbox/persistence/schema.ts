import { z } from 'zod';
import { EnvironmentSpec, SandboxScenario } from '../../../sandbox/spec';
import { executionDigest } from '../execution/runner';
import type { PrivateSandboxReport } from '../integration';

const text = z.string().min(1).max(4096);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = count.min(1);
const versions = z.object({ spec: z.literal('sandbox-spec-v1'), suiteHash: text, simulatorModel: text, judgeModel: text, envHash: text, runtime: text }).strict();
const record = z.record(z.string(), z.unknown());
const transcript = z.array(z.object({ role: z.enum(['user', 'assistant', 'tool']), content: z.string() }).strict());
const duration = z.number().finite().nonnegative();
const tools = z.array(z.object({ seq: count, tool: text, args: z.unknown(), result: z.unknown(), error: z.string().optional(), fault: z.string().optional(), ms: duration, executed: z.boolean().optional() }).strict());
const diff = z.array(z.object({ table: text, inserted: count, updated: count, deleted: count, sample: z.array(record) }).strict()).nullable();
const verdict = z.enum(['pass', 'fail', 'unknown']);
const money = z.object({ status: z.literal('unknown'), microUsd: z.null() }).strict();
const input = z.object({
  jobId: text, trialId: text, trial: count, variant: text, seed: count,
  environment: EnvironmentSpec, scenario: SandboxScenario, versions,
  agentModel: text, agentConfigDigest: text, simulatorConfigDigest: text,
  bounds: z.object({ maxTurns: positive, maxAgentSteps: positive, maxToolCalls: positive, maxTranscriptBytes: positive,
    timeoutMs: positive, cleanupTimeoutMs: positive, budgetMicroUsd: positive }).strict(),
}).strict();
const execution = z.object({
  schema: z.literal('sandbox-execution-v1'), identityDigest: digest, input,
  status: z.enum(['completed', 'bounded', 'aborted', 'unsupported', 'error', 'unresolved']), reason: z.string(),
  runId: text.nullable(), worldId: text.nullable(),
  transcript: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }).strict()),
  toolCalls: tools, diff, outbox: z.array(record).nullable(),
  cleanup: z.object({ run: z.enum(['not_created', 'attempted', 'succeeded', 'unknown']), world: z.enum(['not_created', 'attempted', 'succeeded', 'unknown']) }).strict(),
  grading: z.literal('not_run'), money, infrastructure: z.enum(['known', 'unknown']), elapsedMs: duration,
}).strict();
const grade = z.object({
  runId: text, scenarioId: text, versions, transcript, verdict,
  checks: z.array(z.object({ id: text, kind: z.enum(['state', 'trajectory', 'rubric', 'collateral', 'injection', 'perception', 'latency', 'output', 'refusal']),
    severity: z.enum(['critical', 'high', 'medium', 'low']), verdict, rewardBearing: z.boolean(), detail: z.string(), policyRef: z.string().optional(),
    cause: z.enum(['environment', 'grader', 'unsupported']).optional() }).strict()),
  toolCalls: tools, diff, utility: verdict, security: z.enum(['pass', 'fail', 'unknown', 'not_applicable']),
}).strict().nullable();
const reportSchema = z.object({
  schema: z.literal('sandbox-private-report-v1'), suiteDigest: digest, approvalId: text, execution, grade,
  outcome: z.object({ scenarioId: text, trial: count, seed: text, fixtureHash: text, variant: text, agentVersion: text, versions,
    status: verdict, failureAttribution: z.enum(['agent', 'simulator', 'environment', 'grader', 'unknown']).optional() }).strict(),
  unresolved: z.array(z.string()), money,
}).strict();

/** Validation never normalizes/defaults durable evidence. The digest covers the exact input. */
export function validatePrivateReport(value: unknown, jobId: string): PrivateSandboxReport {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success || executionDigest(parsed.data) !== executionDigest(value)) throw new Error('sandbox_persistence_invalid_report');
  const r = parsed.data;
  const i = r.execution.input;
  if (i.jobId !== jobId || r.execution.identityDigest !== executionDigest(i)
    || i.versions.envHash !== executionDigest(i.environment)
    || r.outcome.scenarioId !== i.scenario.id || r.outcome.trial !== i.trial || r.outcome.seed !== String(i.seed)
    || r.outcome.variant !== i.variant || executionDigest(r.outcome.versions) !== executionDigest(i.versions)
    || executionDigest(r.money) !== executionDigest(r.execution.money)
    || (r.outcome.status === 'pass' && r.outcome.failureAttribution !== undefined)
    || (r.grade !== null && (r.grade.runId !== r.execution.runId || r.grade.scenarioId !== i.scenario.id
      || executionDigest(r.grade.versions) !== executionDigest(i.versions)))) throw new Error('sandbox_persistence_report_identity_conflict');
  return r as PrivateSandboxReport;
}
