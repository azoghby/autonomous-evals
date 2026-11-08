import 'server-only';
import { COMPANY_ROLE_DEFINITIONS } from '@ae/core/agents/company-roles';
import type { JsonTransport } from '@ae/core/targets/transport';
import type { EvalServices, ServiceContext } from '@ae/core/contracts/services';
import { createRemediationServices, remediationDigest } from '@ae/core/evals/remediation/index';
import { TrackBBlockedError } from '@ae/core/evals/service-adapter';
import { assertWorkflowStageOwner } from '@ae/core/db/workflow-stage-authority';
import { currentWorkflowStageScope } from './workflow-stage-runtime';
import { createNaiveTextRuntime, type NaiveTextMethodsDependencies, type NaiveTextRuntime } from './naive-text-methods';
import { createNaiveRemediationAuthority } from './naive-remediation-authority';
import { createNaiveRemediationTrial } from './naive-remediation-trial';
import { canonicalJson } from '@ae/core/evals/text/freeze';
import { loadNaiveRemediationTrialPolicy } from './naive-remediation-policy';

/** The existing core engine currently promises exactly twelve frozen scenarios. */
const unsupported=():never=>{throw new TrackBBlockedError('needs_operator','Remediation currently requires the original twelve frozen scenarios and current Workflow authority.');};
export async function createNaiveRemediationMethods(ctx:ServiceContext,deps:NaiveTextMethodsDependencies={}):Promise<Pick<EvalServices,'proposeAndVerifyFix'>> {
 return composeNaiveRemediationMethods(ctx,await createNaiveTextRuntime(ctx,deps),deps.remediationTransport);
}
/** Shared runner, judge, checkpoints, allocation and cost outbox; no independent provider runtime. */
export function composeNaiveRemediationMethods(ctx:ServiceContext,runtime:NaiveTextRuntime,transport?:JsonTransport):Pick<EvalServices,'proposeAndVerifyFix'> {
 return {proposeAndVerifyFix:async(input,request)=>{
  const stable=runtime.stableContext(input);
  let policyPin:{identity:Parameters<typeof loadNaiveRemediationTrialPolicy>[1];value:unknown}|undefined;
  const guard=async(tx:Parameters<Parameters<typeof runtime.sql.transaction>[0]>[0])=>{
   const stage=currentWorkflowStageScope();
   if(!stage||stage.owner.jobId!==ctx.jobId)return unsupported();
   stage.assertActive?.();
   await assertWorkflowStageOwner(tx,stage.owner);
   if(policyPin&&canonicalJson(await loadNaiveRemediationTrialPolicy(tx,policyPin.identity))!==canonicalJson(policyPin.value))return unsupported();
  };
  const owner=await createNaiveRemediationAuthority(stable,{sql:runtime.sql,authority:runtime.authority,guard});
  const snapshot=await owner.resolve(request.finding.id,request.finding);
  if(snapshot.original.suite.scenarios.length!==12)return unsupported();
  const policy=await runtime.sql.transaction(async tx=>{
   await guard(tx);await runtime.authority.currentInTransaction(tx);
   return loadNaiveRemediationTrialPolicy(tx,{jobId:ctx.jobId,customerId:snapshot.job.customerId,environment:ctx.environment,targetVersion:snapshot.binding.targetVersion});
  });
  policyPin={identity:{jobId:ctx.jobId,customerId:snapshot.job.customerId,environment:ctx.environment,targetVersion:snapshot.binding.targetVersion},value:policy};
  const trialId=`generic-remediation-${remediationDigest({binding:snapshot.binding,findingId:snapshot.finding.id,baseline:snapshot.runId}).slice(0,40)}`;
  async function assertTrialCurrent(tx:Parameters<Parameters<typeof runtime.sql.transaction>[0]>[0]) {
   await owner.assertCurrentInTransaction(tx);
   const fresh=await loadNaiveRemediationTrialPolicy(tx,{jobId:ctx.jobId,customerId:snapshot.job.customerId,environment:ctx.environment,targetVersion:snapshot.binding.targetVersion});
   if(canonicalJson(fresh)!==canonicalJson(policy))return unsupported();
  }
  const secured=policy===null?null:createNaiveRemediationTrial({
   sql:runtime.sql,
   scope:{job:snapshot.job,finding:snapshot.finding,binding:snapshot.binding,original:snapshot.original,trialId,
    endpoint:{kind:policy.kind,isolation:policy.isolation,url:snapshot.target.url,model:snapshot.target.model,...(snapshot.target.apiKey?{apiKey:snapshot.target.apiKey}:{})}},
   operationMicroUsd:policy.operationMicroUsd,
   ...(transport?{transport}:{}),
   reservationScopes:[{key:`agent:quality_investigator:${process.env.NAIVE_BUDGET_PERIOD_ID||new Date().toISOString().slice(0,7)}`,capMicroUsd:COMPANY_ROLE_DEFINITIONS.quality_investigator.monthlyMicroUsd},{key:`job:${ctx.jobId}`,capMicroUsd:runtime.cap},{key:runtime.allocationScope,capMicroUsd:runtime.allocation}],
   assertCurrentInTransaction:assertTrialCurrent,
   assertCurrent:async()=>{await runtime.sql.transaction(assertTrialCurrent);return (await runtime.authority.current()).secrets;},
   resolveJudge:async()=>{await runtime.sql.transaction(assertTrialCurrent);return runtime.judge;},
  });
  const engine=createRemediationServices({runner:runtime.runner,checkpoints:runtime.authority.checkpoints,resolve:async()=>{
   const fresh=await owner.resolve(request.finding.id,request.finding);
   return {...fresh,trial:secured?.trial??null,judge:secured?.judge??null,authorize:secured?.authorize??(async()=>false)};
  }});
  const detailed=await engine.proposeAndVerifyFixDetailed(stable,{findingId:snapshot.finding.id});
  await owner.assertCurrent(detailed);
  await runtime.sql.transaction(assertTrialCurrent);
  return owner.retain(detailed);
 }};
}
