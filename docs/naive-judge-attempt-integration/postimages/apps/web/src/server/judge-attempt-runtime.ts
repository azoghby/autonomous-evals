import 'server-only';
import { createClient } from '@usenaive-sdk/managed-agents';
import { drainJudgeAccounting } from './judge-owner-recovery';
import { trustedJudgeAccountingDependencies } from './judge-owner-recovery-production';
import { NaiveProxyJudgeReconciliationRequiredError } from '@ae/core/judges/naive-proxy';
import { randomUUID } from 'node:crypto';
import type { AgentSqlExecutor, AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { lockJobBudget } from '@ae/core/db/job-budget-authority';
import { assertWorkflowStageOwner } from '@ae/core/db/workflow-stage-authority';
import { PostgresNaiveProxyDispatchStore, type NaiveProxyDispatchConfig } from '@ae/core/judges/naive-proxy-dispatch-store';
import { proxyBillingDigest } from '@ae/core/judges/naive-proxy-reconcile';
import { createNaiveProxyServiceJudge } from '@ae/core/judges/naive-proxy-service';
import type { NaiveProxyJudgeDeps } from '@ae/core/judges/naive-proxy';
import type { ServiceContext } from '@ae/core/contracts/services';
import { currentWorkflowStageScope } from './workflow-stage-runtime';
import { createWorkflowStageBudgetLedger } from './workflow-stage-budget';

const fail=():never=>{throw Error('judge_attempt_authority_unavailable');};
/** Freeze mode per logical operation. A flag only chooses NEW operations. Retained
 * legacy identities continue v1; retained attempts continue v2 even after rollback. */
export async function selectJudgeAttemptMode(sql:AgentTransactionalSql,jobId:string,operationId:string,enabled:boolean,authorizeTransaction?:(tx:AgentSqlExecutor)=>Promise<void>):Promise<'v1'|'v2'> {
 return sql.transaction(async tx=>{
  await lockJobBudget(tx,jobId);
  await authorizeTransaction?.(tx);
  const legacy=proxyBillingDigest({jobId,operationId});
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[jobId,legacy]);
  const hasSchema=!!(await tx.query<{present:boolean}>("SELECT to_regclass('naive_proxy_dispatch.operations') IS NOT NULL AS present")).rows[0]?.present;
  const v2=hasSchema&&(await tx.query('SELECT 1 FROM naive_proxy_dispatch.operations WHERE job_id=$1 AND operation_id=$2',[jobId,operationId])).rows.length>0;
  const v1=(await tx.query(`SELECT 1 FROM text_integration.checkpoints WHERE job_id=$1 AND kind IN ('naive_proxy_judge','naive_proxy_intent','naive_proxy_received') AND id=$2 UNION ALL SELECT 1 FROM agent_persistence.reservations WHERE id=$3 LIMIT 1`,[jobId,legacy,`naive-proxy:${legacy}`])).rows.length>0;
  const retained=(await tx.query<{value:{mode:string};input_digest:string;state:string}>("SELECT value,input_digest,state FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_proxy_mode' AND id=$2",[jobId,legacy])).rows[0];
  if(v1&&v2)return fail();
  if(retained&&(retained.input_digest!==legacy||retained.state!=='completed'||!['v1','v2'].includes(retained.value?.mode)))return fail();
  const evidence=v2?'v2':v1?'v1':undefined;
  if(evidence&&retained&&retained.value.mode!==evidence)return fail();
  const mode=evidence??retained?.value.mode??(enabled?'v2':'v1');
  if(mode==='v2'&&!hasSchema)return fail();
  await tx.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_proxy_mode',$2,$2,$3,'completed',$4::jsonb) ON CONFLICT DO NOTHING`,[jobId,legacy,randomUUID(),JSON.stringify({mode})]);
  return mode as 'v1'|'v2';
 });
}

/** Trusted composition only. All attempt admission and dispatch checks share the
 * operation transaction; settlement deliberately survives stage revocation. */
export function createAttemptAwareJudge(ctx:ServiceContext,deps:Omit<NaiveProxyJudgeDeps,'recordCost'|'dispatch'>,options:{sql:AgentTransactionalSql;config:NaiveProxyDispatchConfig;authorizeTransaction(tx:AgentSqlExecutor):Promise<void>}) {
 // Recheck local cancellation immediately before commit, including asynchronous
 // checks and reservation writes after beforeTransition returns.
 const guarded:AgentTransactionalSql={query:options.sql.query.bind(options.sql),transaction:fn=>options.sql.transaction(async tx=>{const scope=currentWorkflowStageScope();scope?.assertActive?.();const result=await fn(tx);scope?.assertActive?.();return result;})};
 const guardedStore=new PostgresNaiveProxyDispatchStore(guarded,options.config,{
  beforeTransition:async(tx,_phase,identity)=>{
   // Keep the exact same authority/lock ordering for prepare and dispatch.
   await lockJobBudget(tx,identity.jobId);const scope=currentWorkflowStageScope();scope?.assertActive?.();
   if(identity.jobId!==ctx.jobId||scope&&scope.owner.jobId!==identity.jobId)return fail();
   if(scope)await assertWorkflowStageOwner(tx,scope.owner);
   await options.authorizeTransaction(tx);scope?.assertActive?.();
  },ledger:tx=>createWorkflowStageBudgetLedger({query:tx.query.bind(tx),transaction:fn=>fn(tx)}),
 });
 const legacy=createNaiveProxyServiceJudge(ctx,deps);
 const attempts=createNaiveProxyServiceJudge(ctx,{...deps,dispatch:guardedStore});
 return async(input:Parameters<typeof legacy>[0])=>(await selectJudgeAttemptMode(guarded,ctx.jobId,input.operationId,process.env.NAIVE_JUDGE_ATTEMPTS==='1',async tx=>{
  const scope=currentWorkflowStageScope();scope?.assertActive?.();
  if(scope){if(scope.owner.jobId!==ctx.jobId)return fail();await assertWorkflowStageOwner(tx,scope.owner);}
  await options.authorizeTransaction(tx);scope?.assertActive?.();
 })==='v2'?attempts:legacy)(input);
}

/** Drain retained incurred receipts before constructing paid execution authority.
 * Cursor traversal is bounded, and unfinished/unknown accounting keeps work held. */
export async function drainRuntimeJudgeAccounting(jobId:string,sql:AgentTransactionalSql,proxyFetch?:typeof fetch) {
 const retained=await sql.query("SELECT 1 FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_proxy_intent' AND state='completed' LIMIT 1",[jobId]);
 if(!retained.rows.length)return;
 const deps=trustedJudgeAccountingDependencies({sql,...(proxyFetch?{audit:{call:async id=>createClient({apiKey:process.env.NAIVE_API_KEY??'',...(process.env.NAIVE_BASE_URL?{baseUrl:process.env.NAIVE_BASE_URL}:{}),fetch:proxyFetch}).proxy.call(id)}}:{})});let cursor='';
 for(let page=0;page<40;page++){
  const result=await drainJudgeAccounting(jobId,deps,cursor);
  if(result.pending)throw new NaiveProxyJudgeReconciliationRequiredError('accounting');
  if(!result.remaining)return;
  if(!result.nextCursor||result.nextCursor===cursor)break;
  cursor=result.nextCursor;
 }
 throw new NaiveProxyJudgeReconciliationRequiredError('accounting');
}
