import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { containsSecret } from '../../../agents/redact.js';
import { assessDataQuality } from '../../../evals/data/quality.js';
import { reviewDigest } from '../../../evals/data/binding.js';
import { verifyFrozenSuite } from '../../../evals/text/freeze.js';
import { CostEntrySchema, FindingSchema } from '../../../evals/types.js';
import { SuiteRunSchema, ScenarioExecutionSchema } from '../../../evals/text/schema.js';
import { ChatError, ChatScopeSchema, ProgressSnapshotSchema, type ChatScope, type ProgressPort } from '../types.js';
import type { DurableProgressRead, GroundedProgressProjection, ProgressProjectionPorts, ProjectedOutcome, ProjectionPlan } from './types.js';
export type * from './types.js';

const instant = z.iso.datetime({ offset: true });
const invalid: () => never = () => { throw new ChatError('invalid_snapshot'); };
const sameScope = (a: ChatScope, b: ChatScope) => a.subjectId === b.subjectId && a.jobId === b.jobId;
const keyId = (k: ProjectionPlan['checkpoints'][number]['key']) => JSON.stringify([k.jobId, k.kind, k.id, k.inputDigest]);
const unique = (values: readonly string[]) => { if (new Set(values).size !== values.length) invalid(); };
const nonempty = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 4096;
const object = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) invalid(); return v as Record<string, unknown>; };
const calendarResult = z.object({ scenarioId: z.string(), outcome: z.enum(['passed', 'product_failure', 'inconclusive', 'infrastructure_error']),
  scope: z.object({ jobId: z.string(), version: z.string(), runId: z.string() }).passthrough() }).passthrough();

/** Authenticates again even when called directly without createProgressChatService. */
export function createDurableProgressProjection(ports: ProgressProjectionPorts): ProgressPort & {
  project(scope: ChatScope): Promise<GroundedProgressProjection>;
} {
  if (typeof ports.referenceKey !== 'string' || Buffer.byteLength(ports.referenceKey) < 32) invalid();
  async function project(requested: ChatScope): Promise<GroundedProgressProjection> {
    try {
      const scope = ChatScopeSchema.parse(requested);
      const caller = await ports.access.authenticate();
      if (!caller || caller.subjectId !== scope.subjectId) throw new ChatError('not_found');
      const authorized = await ports.access.resolveAuthorizedJob(caller, scope.jobId);
      if (!authorized || !sameScope(scope, ChatScopeSchema.parse(authorized))) throw new ChatError('not_found');
      const plan = await ports.resolve(scope);
      if (!plan || !sameScope(scope, plan.scope)) throw new ChatError('not_found');
      if (!['test', 'live'].includes(plan.environment)) invalid();
      unique(plan.checkpoints.map(p => keyId(p.key)));
      unique(plan.checkpoints.map(p => JSON.stringify([p.key.kind, p.key.id])));
      unique(plan.acquisitionTaskIds);
      for (const p of plan.checkpoints) {
        if (p.key.jobId !== scope.jobId || !nonempty(p.key.kind) || !nonempty(p.key.id) || !/^[a-f0-9]{64}$/.test(p.key.inputDigest)
          || !['planning', 'running', 'investigating'].includes(p.phase)
          || !['text_design', 'text_run', 'calendar_run', 'text_investigation', 'calendar_investigation'].includes(p.format)) invalid();
        const kinds = { text_design: 'design', text_run: 'run_result', calendar_run: 'calendar_run', text_investigation: 'investigation', calendar_investigation: 'calendar_investigation' };
        if (p.key.kind !== kinds[p.format]) invalid();
        if ((p.format.endsWith('_run') || p.format === 'calendar_investigation') && (!nonempty(p.runId) || !nonempty(p.suiteDigest) || !p.scenarioIds?.length)) invalid();
        if (p.scenarioIds) unique(p.scenarioIds);
        if ((p.format === 'calendar_run' || p.format === 'calendar_investigation') && !nonempty(p.branchId)) invalid();
      }
      const read = await ports.reader.read(plan);
      if (!sameScope(scope, read.scope) || read.job.jobId !== scope.jobId) invalid();
      const observedAt = instant.parse(read.observedAt);
      const at = (v: string) => { instant.parse(v); if (Date.parse(v) > Date.parse(observedAt)) invalid(); return v; };
      at(read.job.updatedAt);
      const secrets = typeof ports.knownSecrets === 'function' ? ports.knownSecrets() : ports.knownSecrets ?? [];
      // Raw content never participates in public references, even when its ID looks safe.
      const ref = (kind: string, id: string) => 'ev_' + createHmac('sha256', ports.referenceKey).update(JSON.stringify([scope, kind, id])).digest('hex');
      const snapshot = ProgressSnapshotSchema.parse({ jobId: scope.jobId, observedAt, status: read.job.status,
        statusEvidenceRef: ref('job', scope.jobId), milestones: [], findings: [], blockers: [], costs: [], unknownCosts: read.unknownCosts });
      const addFinding = (checkpoint: string, finding: { id: string; status: 'confirmed' | 'rubric_concern' | 'inconclusive'; severity: 'critical' | 'high' | 'medium' | 'low' }) => {
        if (!nonempty(finding.id)) invalid();
        const id = ref('finding', JSON.stringify([checkpoint, finding.id]));
        snapshot.findings.push({ id, status: finding.status, severity: finding.severity, evidenceRefs: [checkpoint] });
      };
      const phases: GroundedProgressProjection['phases'] = [];
      const acquisition: GroundedProgressProjection['acquisition'] = [];
      const block = (kind: 'input' | 'provider' | 'other', evidenceRef: string) => snapshot.blockers.push({ id: evidenceRef, kind, evidenceRef });
      const milestone = (phase: 'planning' | 'running' | 'investigating' | 'other', evidenceRef: string, time = observedAt) => snapshot.milestones.push({ id: evidenceRef, milestone: phase, at: time, evidenceRef });
      if (read.checkpoints.length !== plan.checkpoints.length || read.acquisition.length !== plan.acquisitionTaskIds.length) invalid();
      unique(read.checkpoints.map(c => keyId(c.key))); unique(read.acquisition.map(t => t.taskId));
      for (const p of plan.checkpoints) {
        const row = read.checkpoints.find(c => keyId(c.key) === keyId(p.key));
        if (!row) return invalid();
        const evidenceRef = ref('checkpoint', keyId(p.key));
        const record = row.record;
        let state: GroundedProgressProjection['phases'][number]['state'] = record?.state ?? 'missing';
        const outcomes: ProjectedOutcome[] = [];
        if (record && !['pending', 'ambiguous', 'completed'].includes(record.state)) invalid();
        if (record?.state === 'completed') {
          if (p.format === 'text_run') {
            const envelope = object(record.value);
            if (envelope.environment !== plan.environment) invalid();
            const run = SuiteRunSchema.parse(envelope.run);
            if (run.jobId !== scope.jobId || run.runId !== p.runId || run.suiteDigest !== p.suiteDigest) invalid();
            at(run.startedAt); at(run.completedAt);
            if (Date.parse(run.startedAt) > Date.parse(run.completedAt)) invalid();
            checkScenarios(run.executions.map(e => e.scenarioId), p.scenarioIds!);
            for (const e of run.executions) {
              if (e.runId !== run.runId) invalid();
              at(e.startedAt); at(e.completedAt);
              if (Date.parse(e.startedAt) > Date.parse(e.completedAt) || Date.parse(e.completedAt) > Date.parse(run.completedAt)) invalid();
              if (e.outcome === 'infrastructure_error' || !e.target.ok) outcomes.push('infrastructure_error');
              else if (!e.checks.length) outcomes.push('inconclusive');
              else for (const c of e.checks) outcomes.push(c.status === 'pass' ? 'passed' : c.status === 'fail' ? 'product_failure' : c.status === 'concern' ? 'rubric_concern' : c.status);
            }
          } else if (p.format === 'calendar_run') {
            const run = object(record.value);
            if (run.jobId !== scope.jobId || run.runId !== p.runId || run.suiteHash !== p.suiteDigest || run.branchId !== p.branchId || !Array.isArray(run.results)) invalid();
            const results = z.array(calendarResult).parse(run.results);
            checkScenarios(results.map(r => r.scenarioId), p.scenarioIds!);
            for (const r of results) {
              if (r.scope.jobId !== scope.jobId || r.scope.version !== run.versionLabel) invalid();
              outcomes.push(r.outcome);
            }
          } else if (p.format === 'text_investigation') {
            const v = object(record.value);
            if (typeof v.investigatorStatus !== 'string' || !Array.isArray(v.findings) || !Array.isArray(v.testDefects)) invalid();
            const findings = z.array(FindingSchema).parse(v.findings);
            const reproductions = z.array(ScenarioExecutionSchema).parse(v.reproductions);
            unique(findings.map(f => f.id));
            unique(reproductions.map(e => e.scenarioId));
            if (findings.length) {
              if (!nonempty(p.runId) || !nonempty(p.suiteDigest) || !p.scenarioIds?.length || p.key.id !== p.runId) invalid();
              const baselines = plan.checkpoints.filter(b => b.format === 'text_run' && b.runId === p.runId && b.suiteDigest === p.suiteDigest);
              if (baselines.length !== 1) invalid();
              const baselineRecord = read.checkpoints.find(r => keyId(r.key) === keyId(baselines[0].key))?.record;
              if (baselineRecord?.state !== 'completed') return invalid();
              const envelope = object(baselineRecord.value);
              const baseline = SuiteRunSchema.parse(envelope.run);
              if (envelope.environment !== plan.environment || baseline.jobId !== scope.jobId || baseline.runId !== p.runId || baseline.suiteDigest !== p.suiteDigest) invalid();
              checkScenarios(baseline.executions.map(e => e.scenarioId), p.scenarioIds!);
              if (reproductions.length > 3 || reproductions.some(e => e.runId === baseline.runId || e.attempt !== 'reproduction' || !p.scenarioIds!.includes(e.scenarioId))) invalid();
              for (const f of findings) {
                const checkIds = f.evidence.filter(e => e.kind === 'check').map(e => e.checkId);
                if (f.source !== 'text_eval' || !checkIds.length) invalid();
                const original = baseline.executions.find(e => e.checks.some(c => f.id === `text:${e.scenarioId}:${c.checkId}` && checkIds.every(id => id === c.checkId)));
                if (!original || original.runId !== baseline.runId) return invalid();
                const check = original.checks.find(c => c.checkId === checkIds[0])!;
                if (!['fail', 'concern'].includes(check.status) || f.evidence.some(e => e.kind === 'trace_event' || (e.kind === 'scenario_response' && (e.scenarioId !== original.scenarioId || e.runId !== baseline.runId)))) invalid();
                const repro = reproductions.find(e => e.scenarioId === original.scenarioId);
                if (f.reproduction?.attempted && (!repro || f.reproduction.runId !== repro.runId)) invalid();
                if (f.label === 'confirmed' && (original.outcome !== 'completed' || !original.target.ok || repro?.outcome !== 'completed' || !repro.target.ok || f.basis !== 'objective' || check.kind !== 'objective' || check.status !== 'fail'
                  || !f.reproduction?.attempted || f.reproduction.reproduced !== true || repro?.checks.find(c => c.checkId === check.checkId)?.status !== 'fail')) invalid();
                addFinding(evidenceRef, { id: f.id, status: f.label, severity: f.severity });
              }
            }
            if (!['completed', 'skipped'].includes(v.investigatorStatus as string)) state = 'blocked';
            if (v.testDefects.length || v.findings.some(f => object(f).label === 'inconclusive')) outcomes.push('inconclusive');
            for (const e of reproductions) {
              at(e.startedAt); at(e.completedAt);
              if (e.outcome === 'infrastructure_error') outcomes.push('infrastructure_error');
              else if (e.checks.some(c => ['not_assessed', 'inconclusive', 'error'].includes(c.status))) outcomes.push('inconclusive');
            }
          } else if (p.format === 'calendar_investigation') {
            const v = object(record.value);
            if (!Array.isArray(v.pendingScenarioIds) || !Array.isArray(v.findings) || !Array.isArray(v.reproductions)) invalid();
            const original = object(v.original);
            if (original.jobId !== scope.jobId || original.runId !== p.runId || original.branchId !== p.branchId
              || original.suiteHash !== p.suiteDigest || !nonempty(original.versionLabel)) invalid();
            const originals = z.array(calendarResult).parse(original.results);
            checkScenarios(originals.map(r => r.scenarioId), p.scenarioIds!);
            unique(originals.map(r => r.scope.runId));
            if (originals.some(r => r.scope.jobId !== scope.jobId || r.scope.version !== original.versionLabel)) invalid();
            const pending = z.array(z.string()).parse(v.pendingScenarioIds);
            unique(pending);
            if (pending.length + v.reproductions.length > 3 || pending.some(id => !originals.some(r => r.scenarioId === id && r.outcome === 'product_failure'))) invalid();
            if (v.pendingScenarioIds.length) state = 'blocked';
            if (v.findings.some(f => object(f).status === 'inconclusive')) outcomes.push('inconclusive');
            const reproduced = new Map<string, z.infer<typeof calendarResult>>();
            for (const reproduction of v.reproductions) {
              const entry = object(reproduction);
              const id = z.string().parse(entry.originalScenarioId);
              const r = calendarResult.parse(entry.result);
              if (reproduced.has(id) || pending.includes(id) || r.scenarioId !== id
                || !originals.some(o => o.scenarioId === id && o.outcome === 'product_failure')
                || r.scope.jobId !== scope.jobId || r.scope.version !== original.versionLabel
                || originals.some(o => o.scope.runId === r.scope.runId)) invalid();
              reproduced.set(id, r);
              outcomes.push(r.outcome);
            }
            unique([...reproduced.values()].map(r => r.scope.runId));
            const findings = v.findings.map(object);
            checkScenarios(findings.map(f => z.string().parse(f.scenarioId)), originals.filter(r => r.outcome !== 'passed').map(r => r.scenarioId));
            const sameRunScope = (a: unknown, b: z.infer<typeof calendarResult>['scope']) => {
              const actual = object(a);
              return actual.jobId === b.jobId && actual.version === b.version && actual.runId === b.runId;
            };
            for (const finding of findings) {
              const source = originals.find(r => r.scenarioId === finding.scenarioId)!;
              const association = object(finding.association);
              const rerun = reproduced.get(source.scenarioId);
              if (association.jobId !== scope.jobId || association.branchId !== p.branchId || association.suiteHash !== p.suiteDigest
                || !sameRunScope(association.scope, source.scope) || finding.reproductions !== (rerun ? 1 : 0)
                || !['confirmed', 'inconclusive'].includes(String(finding.status))
                || (rerun ? !sameRunScope(association.reproductionScope, rerun.scope) : association.reproductionScope !== undefined)
                || (finding.status === 'confirmed' && (!rerun || rerun.outcome !== 'product_failure'))) invalid();
              addFinding(evidenceRef, z.object({ id: z.string().min(1), status: z.enum(['confirmed', 'inconclusive']), severity: z.enum(['critical', 'high', 'medium', 'low']) }).parse(finding));
            }
          } else if (p.format === 'text_design') {
            const v = object(record.value);
            if (v.status === 'blocked') state = 'blocked';
            else {
              if (v.status !== 'completed') invalid();
              const suite = verifyFrozenSuite(v.suite);
              if (suite.jobId !== scope.jobId) invalid();
              if (p.suiteDigest !== undefined && suite.digest !== p.suiteDigest) invalid();
              at(suite.frozenAt);
            }
          }
          // A persisted phase completion never proves report delivery.
          milestone(p.phase, evidenceRef);
        }
        if (state !== 'completed' || outcomes.some(o => ['infrastructure_error', 'error', 'inconclusive', 'not_assessed'].includes(o))) block(state === 'missing' ? 'other' : 'provider', evidenceRef);
        phases.push({ evidenceRef, phase: p.phase, state, outcomes });
      }
      for (const taskId of [...plan.acquisitionTaskIds].sort()) {
        const row = read.acquisition.find(r => r.taskId === taskId); if (!row) return invalid();
        const evidenceRef = ref('acquisition', taskId); const task = row.record;
        if (!task) { acquisition.push({ evidenceRef, state: 'missing', phase: null }); block('input', evidenceRef); continue; }
        validateTask(task, taskId, scope.jobId); at(task.updatedAt);
        for (const d of task.decisions) { at(d.at); if (Date.parse(d.at) > Date.parse(task.updatedAt)) invalid(); }
        if (task.state === 'ready') {
          const evidenceAt = (time: string) => { at(time); if (Date.parse(time) > Date.parse(task.updatedAt)) invalid(); };
          for (const source of task.sources) {
            evidenceAt(source.provenance.retrievedAt);
            if (source.review.status !== 'pending' || source.review.reviewedAt) evidenceAt(source.review.reviewedAt);
          }
          for (const item of task.cases) if (item.verification && (item.verification.status !== 'pending' || item.verification.reviewedAt)) evidenceAt(item.verification.reviewedAt);
          if (task.phase !== 'complete' || reviewDigest(assessDataQuality(task.spec, task.cases, task.sources, { knownSecrets: secrets })) !== reviewDigest(task.assessment) || task.assessment.status !== 'sufficient') invalid();
        } else block('input', evidenceRef);
        milestone('other', evidenceRef, task.updatedAt);
        acquisition.push({ evidenceRef, state: task.state, phase: task.phase });
      }
      const costIds: string[] = [];
      for (const raw of read.costs) {
        const cost = CostEntrySchema.parse(raw);
        if (cost.jobId !== scope.jobId || !cost.measured || !nonempty(cost.externalId)) invalid();
        at(cost.recordedAt);
        const id = ref('cost', JSON.stringify([cost.source, cost.externalId])); costIds.push(id);
        snapshot.costs.push({ id, source: 'naive', microUsd: cost.microUsd, evidenceRef: id });
      }
      unique(costIds);
      if (!Number.isSafeInteger(snapshot.costs.reduce((s, c) => s + c.microUsd, 0))) invalid();
      // Terminal delivery requires a separate application fact AND resolved durable evidence.
      if (snapshot.status === 'delivered' && (snapshot.blockers.length || !phases.length || phases.some(p => p.state !== 'completed'))) invalid();
      unique(snapshot.findings.map(f => f.id));
      for (const rows of [snapshot.milestones, snapshot.blockers, snapshot.costs, snapshot.findings]) rows.sort((a, b) => a.id.localeCompare(b.id));
      phases.sort((a, b) => a.evidenceRef.localeCompare(b.evidenceRef)); acquisition.sort((a, b) => a.evidenceRef.localeCompare(b.evidenceRef));
      const result = { snapshot: ProgressSnapshotSchema.parse(snapshot), phases, acquisition };
      const encoded = JSON.stringify(result);
      if (containsSecret(encoded, secrets) || secrets.some(s => s.length > 0 && encoded.includes(s))) invalid();
      return result;
    } catch (error) {
      if (error instanceof ChatError) throw error;
      return invalid();
    }
  }
  return { project, read: async scope => (await project(scope)).snapshot };
}
function checkScenarios(actual: string[], expected: readonly string[]) {
  unique(actual); if (actual.length !== expected.length || actual.some(id => !expected.includes(id))) invalid();
}
function validateTask(task: NonNullable<DurableProgressRead['acquisition'][number]['record']>, taskId: string, jobId: string) {
  if (task.taskId !== taskId || task.spec.taskId !== taskId || task.spec.jobId !== jobId
    || !Number.isSafeInteger(task.revision) || task.revision < 0 || !/^[a-f0-9]{64}$/.test(task.requestHash)
    || !['acquiring', 'ready', 'waiting_for_data', 'waiting_for_expert'].includes(task.state)
    || !['discovery', 'generation', 'expert', 'complete'].includes(task.phase)) invalid();
}
export { createDurableProgressReader, type ConsistentProgressReadPort, type DurableReadView } from './reader.js';
