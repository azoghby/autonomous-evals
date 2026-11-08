import 'server-only';
import { FatalError } from 'workflow';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { resolveNaiveTextExecution, type NaiveTextExecutionIdentity, type NaiveTextExecutionProfile } from './naive-text-execution-selection';
import { readRoutingSelection } from './naive-method-routing';

export function factualGapExecutionEnabled(env:Record<string,string|undefined>=process.env):boolean {
 const flag=env.EVAL_NAIVE_FACTUAL_GAPS;
 if(flag!==undefined&&flag!=='0'&&flag!=='1')throw new FatalError('NAIVE_EXECUTION_SELECTION_HOLD');
 return flag==='1';
}
/** Resolve retained policy before flag-based service selection, including rollback to lite. */
export async function resolveJobNaiveExecution(jobId:string,deps:{sql?:AgentTransactionalSql;env?:Record<string,string|undefined>}={}):Promise<
 {generic:false}|{generic:true;identity:NaiveTextExecutionIdentity;profile:NaiveTextExecutionProfile;sql:AgentTransactionalSql}> {
 const env=deps.env??process.env;
 const sql=deps.sql??(await import('@/server/automated-expert-owner')).expertOwnerDatabase();
 const job=(await sql.query<{customer_id:string;environment:'test'|'live';package:string;is_mock:boolean}>('SELECT customer_id::text,environment,package,is_mock FROM jobs WHERE id=$1',[jobId])).rows[0];
 if(!job)throw new FatalError('NAIVE_EXECUTION_SELECTION_HOLD');
 if(job.package!=='text_eval'||job.is_mock)return {generic:false};
 const prior=(await sql.query<{kind:string;value:any}>(`SELECT kind,value FROM text_integration.checkpoints WHERE job_id=$1 AND (kind='naive_execution_policy' OR kind='naive_method_binding' OR kind='naive_factual_gap_proposal') LIMIT 4`,[jobId])).rows;
 const retained=prior.some(row=>row.kind!=='naive_execution_policy'||row.value?.profile?.policyId!=='generic-text-v1');
 // An existing factual selection/operation is a hold even when the process is rolled back.
 if(retained&&env.EVAL_SERVICES!=='real')throw new FatalError('NAIVE_EXECUTION_SELECTION_HOLD');
 const selection=readRoutingSelection(env);
 const selected=['designSuite','runSuite','investigate'].every(method=>selection.methods.has(method as 'designSuite'));
 if(!selected){if(retained)throw new FatalError('NAIVE_EXECUTION_SELECTION_HOLD');return {generic:false};}
 const identity={jobId,customerId:job.customer_id,environment:job.environment};
 const resolved=await resolveNaiveTextExecution(sql,identity,{realMode:env.EVAL_SERVICES==='real',factualGapEnabled:factualGapExecutionEnabled(env)});
 if(resolved.status==='on_hold')throw new FatalError('NAIVE_EXECUTION_SELECTION_HOLD');
 return {generic:true,identity,profile:resolved.profile,sql};
}
