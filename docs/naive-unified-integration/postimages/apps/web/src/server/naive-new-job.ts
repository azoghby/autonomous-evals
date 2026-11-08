import 'server-only';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import type { Environment } from '@ae/core/contracts/index';
import { readRoutingSelection } from './naive-method-routing';
import { enrollNewNaiveTextExecution } from './naive-text-execution-selection';

/** Only trusted server configuration can opt a newly created job in. */
export function readNewJobFactualGapEnabled(job:{package:string;isMock:boolean},env:Record<string,string|undefined>=process.env):boolean {
 const flag=env.EVAL_NAIVE_FACTUAL_GAPS;
 if(flag!==undefined&&flag!=='0'&&flag!=='1')throw new Error('Invalid EVAL_NAIVE_FACTUAL_GAPS');
 if(flag!=='1'||job.package!=='text_eval')return false;
 const selection=readRoutingSelection(env);
 if(env.EVAL_SERVICES!=='real'||job.isMock||!['designSuite','runSuite','investigate'].every(method=>selection.methods.has(method as 'designSuite'|'runSuite'|'investigate')))throw new Error('Factual gaps require complete real nonmock text evaluation');
 return true;
}

export interface NewFactualJob {
 jobId:string;customerId:string;environment:Environment;idempotencyKey:string;
 intake:Record<string,unknown>;traceBlobPath:string|null;retestOfJobId?:string;ciphertext:string|null;
}
/** A conflict is an existing job, never authorization to enroll or replace credentials. */
export async function insertNewFactualJob(sql:AgentTransactionalSql,args:NewFactualJob):Promise<string>{
 return sql.transaction(async tx=>{
  const inserted=(await tx.query<{id:string}>(`INSERT INTO jobs(id,customer_id,package,state,environment,intake,trace_blob_path,is_mock,idempotency_key,retest_of_job_id) VALUES($1,$2,'text_eval','draft',$3,$4::jsonb,$5,false,$6,$7) ON CONFLICT(customer_id,idempotency_key) DO NOTHING RETURNING id::text`,[args.jobId,args.customerId,args.environment,JSON.stringify(args.intake),args.traceBlobPath,args.idempotencyKey,args.retestOfJobId??null])).rows[0];
  if(!inserted){
   const existing=(await tx.query<{id:string}>('SELECT id::text FROM jobs WHERE customer_id=$1 AND idempotency_key=$2',[args.customerId,args.idempotencyKey])).rows[0];
   if(!existing)throw new Error('new_job_idempotency_conflict');
   return existing.id;
  }
  if(args.ciphertext!==null)await tx.query('INSERT INTO job_credentials(job_id,ciphertext) VALUES($1,$2)',[args.jobId,args.ciphertext]);
  await enrollNewNaiveTextExecution(tx,{jobId:args.jobId,customerId:args.customerId,environment:args.environment},{factualGapEnabled:true,expertTaskId:`factual-gap:${args.jobId}`});
  return args.jobId;
 });
}
