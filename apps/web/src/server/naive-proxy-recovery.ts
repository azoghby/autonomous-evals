import 'server-only';
import { z } from 'zod';
import { type AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { JOB_BUDGET_MICRO_USD } from '@ae/core/contracts/index';
import { type NaiveProxyReconcileDeps } from '@ae/core/judges/naive-proxy-reconcile';
import { expertOwnerDatabase } from './automated-expert-owner';
import { requireOperator } from './http';
import { drainJudgeAccounting } from './judge-owner-recovery';
import { trustedJudgeAccountingDependencies } from './judge-owner-recovery-production';

const recoveryHeaders={'Cache-Control':'private, no-store, max-age=0',Vary:'Cookie','X-Content-Type-Options':'nosniff'};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:recoveryHeaders});
const jsonError=(status:number,error:string)=>json({error},status);
async function privateDenial(res:Response){return json(await res.json(),res.status);}
async function boundedBody(req:Request):Promise<string>{
 const length=req.headers.get('content-length');
 if(length&&(!/^\d+$/.test(length)||Number(length)>256))throw Error('body_large');
 if(!req.body)return '';
 if(req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw Error('body_invalid');
 const reader=req.body.getReader();const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>256){await reader.cancel();throw Error('body_large');}chunks.push(chunk.value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
export const PROXY_RECOVERY_BATCH = 25;
interface JobOwner { id:string; customer_id:string; environment:'test'|'live'; package:keyof typeof JOB_BUDGET_MICRO_USD }
export interface ProxyRecoveryDeps {
 sql?:AgentTransactionalSql;
 /** Audit-only SDK port. No provider creation API is accepted. */
 audit?:NaiveProxyReconcileDeps['proxy'];
}
/** Accounting-only operator recovery. Cancelled jobs, revoked expert plans and exhausted
 * inference budgets remain eligible for their already incurred, provider-audited costs. */
export async function handleProxyBillingRecovery(req:Request,jobId:string,deps:ProxyRecoveryDeps={}):Promise<Response> {
 const auth=await requireOperator();if(auth.res)return privateDenial(auth.res);
 if(!z.uuid().safeParse(jobId).success)return jsonError(400,'Invalid job');
 let body:string;try{body=await boundedBody(req);}catch(error){return jsonError(error instanceof Error&&error.message==='body_large'?413:400,'Invalid recovery request body');}
 let cursor='';
 try {const parsed=z.object({cursor:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().safeParse(body.trim()?JSON.parse(body):{});if(!parsed.success)return jsonError(400,'Only a valid accounting cursor is accepted');cursor=parsed.data.cursor??'';}
 catch{return jsonError(400,'Invalid JSON');}
 try {
  const sql=deps.sql??expertOwnerDatabase();
  const job=(await sql.query<JobOwner>('SELECT id::text,customer_id::text,environment,package FROM jobs WHERE id=$1',[jobId])).rows[0];
  if(!job||!z.uuid().safeParse(job.customer_id).success||!['test','live'].includes(job.environment)||!(job.package in JOB_BUDGET_MICRO_USD))return jsonError(404,'Job unavailable');
  const actor=auth.viewer.id;
  const accounting=trustedJudgeAccountingDependencies({sql,...(deps.audit?{audit:deps.audit}:{})});
  return json(await drainJudgeAccounting(jobId,{...accounting,authorizeAccounting:async()=>{
   const active=await requireOperator();if(active.res||active.viewer.id!==actor)throw Error('operator_required');
  }},cursor));
 }catch{
  const current=await requireOperator();if(current.res)return privateDenial(current.res);
  if(current.viewer.id!==auth.viewer.id)return jsonError(403,'Operator session changed');
  return jsonError(503,'Proxy accounting reconciliation unavailable');
 }
}
