import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { containsSecret } from '@ae/core/agents/redact';
import { MONITORING_RUN_BUDGET_MICRO_USD, JOB_BUDGET_MICRO_USD } from '@ae/core/contracts/index';
import type { ServiceContext } from '@ae/core/contracts/services';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { ROLE_DEFINITIONS } from '@ae/core/agents/roles';
import { PostgresBudgetLedger } from '@ae/core/agents/postgres-ports';
import type { AgentTaskRunner } from '@ae/core/agents/session-service';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import { createTextEvaluationServices } from '@ae/core/evals/integration/services';
import { createComparisonMonitoringService } from '@ae/core/monitoring/composition';
import type { ComparisonRequest, ComparisonSuite, RichRunArtifact } from '@ae/core/monitoring/composition';
import { createTextComparisonAdapter, createCalendarComparisonAdapter, createRetainedComparisonAdapter } from '@ae/core/monitoring/adapters';
import { canonicalJson } from '@ae/core/evals/text';
import type { createCalendarEvaluationServices } from '@ae/core/evals/calendar-integration';
import type { TextTargetPort } from '@ae/core/evals/types';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const version = z.object({ version: id, targetId: id, branchId: id.nullable(), configurationDigest: z.string().regex(/^[a-f0-9]{64}$/), endpointSlot: z.enum(['endpoint', 'endpointA', 'endpointB']), endpointOverride:z.object({url:z.string().url().max(4096),model:z.string().min(1).max(256)}).strict().optional() }).strict();
export const comparisonBindingSchema = z.object({
  suiteId: id, scope: z.enum(['base12', 'augmented']), scenarioIds: z.array(id),
  baseline: version, current: version,
  // Reviewed policy: reservation per outbound target call; unmeasured reservations remain held.
  targetCallMicroUsd: z.number().int().positive().safe(), jobCapMicroUsd: z.number().int().positive().safe(),
}).strict();
export type ComparisonBinding = z.infer<typeof comparisonBindingSchema>;
export const comparisonDigest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const refused = (): never => { throw new Error('rich_comparison_refused'); };
export interface ComparisonPrincipal { tenantId: string; environment: 'test' | 'live' }
export interface ComparisonRuntime {
  runner: AgentTaskRunner;
  knownSecrets: readonly string[];
  verify(jobId: string, binding: ComparisonBinding, retained: RichRunArtifact): Promise<{scenarioIds:string[]}>;
  /** Called again immediately before every target operation; closure loads decrypted canonical intake. */
  target(binding: ComparisonBinding['current']): Promise<TextTargetPort>;
  /** Calendar factory must guard every outbound complete() with guard(), and verify branch ownership. */
  calendar?(binding: ComparisonBinding['current'], guard: (operation: string) => Promise<void>, checkpoints: PostgresTextCheckpointStore): Promise<ReturnType<typeof createCalendarEvaluationServices>>;
}
/** Concrete SQL-backed app coordinator. Runtime contains transports, not authorization decisions. */
export function createRichComparisonApp(sql: AgentTransactionalSql, runtime: ComparisonRuntime) {
  const checkpoints = new PostgresTextCheckpointStore(sql);
  async function authority(principal: ComparisonPrincipal, jobId: string, subscriptionId?: string) {
    const row = (await sql.query<{ customer_id: string; environment: string; state: string; package: keyof typeof JOB_BUDGET_MICRO_USD; is_mock: boolean; is_internal_fixture: boolean; suite: ComparisonSuite; retained: RichRunArtifact; binding: unknown; binding_digest: string }>(`SELECT j.customer_id,j.environment,j.state,j.package,j.is_mock,c.is_internal_fixture,b.suite,b.retained,b.binding,b.binding_digest
      FROM jobs j JOIN customers c ON c.id=j.customer_id JOIN workflow_comparison.bindings b ON b.job_id=j.id
      WHERE j.id=$1 AND j.customer_id=$2 AND j.environment=$3`, [jobId,principal.tenantId,principal.environment])).rows[0];
    if (!row || row.is_mock || row.state !== 'delivered' || comparisonDigest({suite:row.suite,retained:row.retained,binding:row.binding}) !== row.binding_digest) return refused();
    if(runtime.knownSecrets.some(s=>s.length<4) || containsSecret(canonicalJson(row),runtime.knownSecrets)) return refused();
    const binding = comparisonBindingSchema.parse(row.binding);
    const canonical = await runtime.verify(jobId,binding,row.retained);
    if (binding.jobCapMicroUsd > JOB_BUDGET_MICRO_USD[row.package] || !JOB_BUDGET_MICRO_USD[row.package]
      || canonicalJson([...canonical.scenarioIds].sort()) !== canonicalJson([...binding.scenarioIds].sort())) return refused();
    // Full inventory stays visible even when execution is refused. Explicit base12 never means pack coverage.
    if (binding.scope !== 'base12' || binding.scenarioIds.length !== 12 || new Set(binding.scenarioIds).size !== 12
      || canonicalJson([...binding.scenarioIds].sort()) !== canonicalJson(row.suite.scenarios.map(s=>s.id).sort())) return refused();
    if (subscriptionId) {
      const sub = await sql.query(`SELECT id FROM monitoring_subscriptions WHERE id=$1 AND job_id=$2 AND customer_id=$3 AND environment=$4 AND status='active' AND stripe_subscription_id IS NOT NULL`, [subscriptionId,jobId,principal.tenantId,principal.environment]);
      if (!sub.rows.length) return refused();
    }
    const paid = await sql.query(`SELECT id FROM payments WHERE job_id=$1 AND environment=$2 AND status IN ('paid','captured') AND kind='one_time'`,[jobId,principal.environment]);
    if (!paid.rows.length) return refused();
    return { ...row, binding };
  }
  async function compare(principal: ComparisonPrincipal, ctx: ServiceContext, request: ComparisonRequest, subscriptionId?: string) {
    if ((request.mode === 'monitoring') !== Boolean(subscriptionId)) return refused();
    const a = await authority(principal,ctx.jobId,subscriptionId);
    if (ctx.environment !== principal.environment || request.baselineVersion !== a.binding.baseline.version || request.currentVersion !== a.binding.current.version) return refused();
    const immutable = { tenantId:principal.tenantId, environment:principal.environment, jobId:ctx.jobId, bindingDigest:a.binding_digest, request, subscriptionId:subscriptionId??null };
    // Stable tick/request identity is committed before factory construction, agent calls, or targets.
    const tick = {jobId:ctx.jobId,kind:'app_rich_tick',id:request.operationId,inputDigest:comparisonDigest(immutable)};
    const claim = await checkpoints.claim(tick);
    if (claim.state === 'completed') return claim.value;
    if (claim.state !== 'claimed') throw new Error('rich_tick_needs_reconciliation');
    const reauthorize = async () => { const latest = await authority(principal,ctx.jobId,subscriptionId); if(latest.binding_digest !== a.binding_digest) refused(); };
    try {
      const costs = async (operationId: string) => {
        const rows = await sql.query<{ id:string; source:string; micro_usd:string|number }>('SELECT id,source,micro_usd FROM workflow_comparison.costs WHERE job_id=$1 AND operation_id=$2',[ctx.jobId,operationId]);
        return {costs:rows.rows.map(r=>({id:r.id,source:r.source,microUsd:Number(r.micro_usd),measured:true as const})),unknownCosts:['target_provider_usage_unmeasured','hosting_unmeasured','investigation_usage_not_in_ledger_is_unknown','retained_baseline_and_suite_design_costs_not_fully_measured']};
      };
      const adapter = async (v:ComparisonBinding['current']) => {
        const guard = async (operation:string) => {
          await reauthorize();
          const period=process.env.NAIVE_BUDGET_PERIOD_ID; if(!period || !/^[A-Za-z0-9_-]+$/.test(period))return refused();
          const reserved = await new PostgresBudgetLedger(sql).reserve({reservationId:`cmp:${comparisonDigest({immutable,v,operation})}`,jobId:ctx.jobId,amountMicroUsd:a.binding.targetCallMicroUsd,scopes:[{key:`agent:evaluation_engineer:${period}`,capMicroUsd:ROLE_DEFINITIONS.evaluation_engineer.periodCapMicroUsd},{key:`job:${ctx.jobId}`,capMicroUsd:a.binding.jobCapMicroUsd}, ...(subscriptionId?[{key:`monitor:${subscriptionId}:${request.operationId}`,capMicroUsd:MONITORING_RUN_BUDGET_MICRO_USD}]:[])]});
          if (!reserved.ok) refused();
          // No automatic settlement/release: target transport supplies no measured receipt. Hold for reconciliation.
        };
        if ('digest' in a.suite) {
          const suite = a.suite;
          const operationId = comparisonDigest([principal.tenantId,ctx.jobId,request.operationId,v===a.binding.baseline?'baseline':'current']);
          const scopedCtx = {...ctx, recordCost:async (cost:Parameters<ServiceContext['recordCost']>[0])=>{
            const key=String(cost.meta?.idempotencyKey??''); if(!key || !Number.isSafeInteger(cost.microUsd) || cost.microUsd<0) refused();
            await sql.transaction(async tx=>{
              await tx.query('INSERT INTO workflow_comparison.costs(job_id,operation_id,source,id,micro_usd) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[ctx.jobId,operationId,cost.source,key,cost.microUsd]);
              const same=await tx.query('SELECT id FROM workflow_comparison.costs WHERE job_id=$1 AND operation_id=$2 AND source=$3 AND id=$4 AND micro_usd=$5',[ctx.jobId,operationId,cost.source,key,cost.microUsd]);
              if(!same.rows.length) refused();
            });
          }};
          const services = createTextEvaluationServices({checkpoints,runner:runtime.runner,resolveApprovedSuite:async()=>suite,resolve:async()=>{
            await reauthorize();
            return {job:{jobId:ctx.jobId,customerId:principal.tenantId,environment:ctx.environment,package:'text_eval' as const,isFixture:a.is_internal_fixture,linkedRetestOf:null,quoteVersion:null},targetVersion:v.version,knownSecrets:runtime.knownSecrets,judge:null,
              target:{send:async req=>{await guard(`${req.runId}:${req.scenarioId}`);return (await runtime.target(v)).send(req);}}};
          }});
          return createTextComparisonAdapter({services,ctx:scopedCtx,suiteDigest:suite.digest,readCosts:costs});
        }
        if (!runtime.calendar) return refused();
        const services=await runtime.calendar(v,guard,checkpoints);
        // Calendar checkpoint identity includes target/branch. Use distinct references to identical frozen content.
        const suiteId=comparisonDigest({suiteId:a.binding.suiteId,version:v.version,targetId:v.targetId,branchId:v.branchId});
        await services.freezeSuite(ctx,{suiteId});
        return createCalendarComparisonAdapter({services,ctx,suiteId,readCosts:costs});
      };
      const service = createComparisonMonitoringService({checkpoints,resolve:async()=>{
        await reauthorize();
        return {tenantId:principal.tenantId,jobId:ctx.jobId,environment:ctx.environment,isFixture:a.is_internal_fixture,suite:a.suite,scenarioIds:a.binding.scenarioIds,knownSecrets:runtime.knownSecrets,
          baseline:{...a.binding.baseline,adapter:request.mode==='monitoring'?createRetainedComparisonAdapter(a.retained):await adapter(a.binding.baseline)},
          current:{...a.binding.current,adapter:await adapter(a.binding.current)}};
      }});
      const result = await service.compare(ctx,request);
      await reauthorize();
      await checkpoints.complete(tick,claim.token,result); // full rich result + generic alert drafts, never boolean RunResult
      return result;
    } catch (error) { await checkpoints.markAmbiguous(tick,claim.token); throw error; }
  }
  return {compare,
    async inventory(principal:ComparisonPrincipal,jobId:string) {
      const row=await sql.query<{binding:unknown;retained:RichRunArtifact}>(`SELECT b.binding,b.retained FROM workflow_comparison.bindings b JOIN jobs j ON j.id=b.job_id WHERE j.id=$1 AND j.customer_id=$2 AND j.environment=$3`,[jobId,principal.tenantId,principal.environment]);
      const saved=row.rows[0];if(!saved)return null;
      const binding=comparisonBindingSchema.parse(saved.binding);
      const source=await runtime.verify(jobId,binding,saved.retained);
      const scenarioIds=[...new Set([...binding.scenarioIds,...source.scenarioIds])];
      return {...binding,scenarioIds,scope:scenarioIds.length===12?binding.scope:'augmented'};
    },
    async read(principal:ComparisonPrincipal,jobId:string,operationId:string) {
      await authority(principal,jobId); // every read reauthenticates canonical ownership/payment, including replay
      return checkpoints.get({jobId,kind:'app_rich_tick',id:operationId});
    },
  };
}
