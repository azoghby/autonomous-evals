import { createHash } from 'node:crypto';
import type { AgentSqlExecutor } from '@ae/core/agents/postgres-ports';
import type { AgentTaskRecord, JobRef } from '@ae/core/evals/types';
import type { AgentTaskRunner } from '@ae/core/agents/session-service';
import { taskKeyFor, outputJsonSchema } from '@ae/core/agents/session-service';
import { designTextSuite } from '@ae/core/evals/text/design';
import { canonicalJson, verifyAdmittedFrozenSuite } from '@ae/core/evals/text/freeze';
import type { FrozenTextSuite } from '@ae/core/evals/text/schema';
import type { NaiveTextDesignIdentity } from '@ae/core/evals/naive-design-service';
import type { NaiveArtifactStoreDeps } from '@ae/core/evals/naive-artifact-store';
import { TrackBBlockedError } from '@ae/core/evals/service-adapter';
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const reject=():never=>{throw new TrackBBlockedError('rejected_input','Generic engine admission evidence unavailable or changed.');};
type Row={input_digest:string;state:string;value:any};
const POLICY='automated-text-design-v1';
/** Code authority only: reconstructs the engine's bounded design from retained completed
 * agent tasks, including exact dispatch messages. It makes no model/provider calls and
 * does not assert expert factual certification or human approval. Caller supplies its
 * existing pinned transaction; canonical owner/intake/target authorization stays upstream. */
export function createNaiveEngineAdmissionPolicy(){
 async function evidence(tx:AgentSqlExecutor,identity:NaiveTextDesignIdentity,expected?:FrozenTextSuite){
  const binding=(await tx.query<Row>(`SELECT input_digest,state,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_method_binding' AND id=$2 FOR SHARE`,[identity.jobId,identity.designId])).rows[0];
  const job:JobRef=binding?.value?.job;
  if(!binding||binding.state!=='completed'||hash(binding.value)!==binding.input_digest||!job||job.jobId!==identity.jobId||job.customerId!==identity.customerId||job.environment!==identity.environment||job.package!=='text_eval'||job.isFixture||binding.value.designId!==identity.designId||binding.value.versionLabel!==identity.versionLabel)return reject();
  const row=(await tx.query<Row>(`SELECT input_digest,state,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='design' AND id=$2 FOR SHARE`,[identity.jobId,identity.designId])).rows[0];
  if(!row||row.state!=='completed')return null;
  if(row.value?.status!=='completed')return reject();
  const suite=verifyAdmittedFrozenSuite(row.value.suite);
  const input={suiteId:identity.designId,versionLabel:identity.versionLabel,systemPrompt:suite.systemPrompt,referenceText:suite.referenceText};
  if(suite.jobId!==identity.jobId||suite.versionLabel!==identity.versionLabel||row.input_digest!==hash({environment:identity.environment,input})||expected&&canonicalJson(suite)!==canonicalJson(expected))return reject();
  const records:{revision:number;record:AgentTaskRecord}[]=[];
  // Replay deterministic code gates from the original completed outputs. suite.review
  // is compared with the reconstruction; its self-reported sessions confer no authority.
  const runner={run:async(spec:any)=>{
   const key=taskKeyFor(job.jobId,spec.role,spec.purpose,1);
   const saved=(await tx.query<{revision:number;record:AgentTaskRecord}>(`SELECT revision,record FROM agent_persistence.tasks WHERE task_key=$1 FOR SHARE`,[key])).rows[0];
   const r=saved?.record,b=r?.requestBody,m=b?.metadata;
   if(!r||r.taskKey!==key||r.jobId!==job.jobId||r.role!==spec.role||r.purpose!==spec.purpose||r.attempt!==1||r.state!=='completed'||!r.sessionId||!r.agentId||!r.agentVersion||r.consumedMicroUsd===null||!Number.isSafeInteger(r.consumedMicroUsd)||r.consumedMicroUsd<0||r.error!==null||!b||b.agent_id!==r.agentId||b.agent_version!==r.agentVersion||b.structured_output_required!==true||canonicalJson(b.output_schema)!==canonicalJson(outputJsonSchema(spec.output.schema))||b.message!==spec.message||m?.ae_task_key!==key||m.ae_job_id!==job.jobId||m.ae_role!==spec.role||m.ae_purpose!==spec.purpose||m.ae_output!==spec.output.name||m.ae_environment!==job.environment||m.ae_fixture!==false||m.ae_package!=='text_eval'||!spec.output.schema.safeParse(r.result).success)return reject();
   records.push(saved);
   return {status:'completed',taskKey:key,output:r.result,session:{sessionId:r.sessionId,agentId:r.agentId,agentVersion:r.agentVersion,consumedMicroUsd:r.consumedMicroUsd,tokenUsage:r.tokenUsage??{}},cost:{jobId:r.jobId,source:'naive_session',role:r.role,externalId:r.sessionId,purpose:r.purpose,microUsd:r.consumedMicroUsd,measured:true,recordedAt:r.updatedAt}};
  }} as unknown as AgentTaskRunner;
  const reconstructed=await designTextSuite({job,versionLabel:suite.versionLabel,systemPrompt:suite.systemPrompt,referenceText:suite.referenceText},{runner,now:()=>new Date(suite.frozenAt)});
  if(canonicalJson(reconstructed)!==canonicalJson(row.value))return reject();
  const sessions=suite.review.sessions;
  if(new Set(sessions.map(s=>s.sessionId)).size!==sessions.length||new Set(sessions.map(s=>s.role)).size!==2||new Set(records.map(r=>r.record.agentId)).size!==2)return reject();
  return {identity,engine:row,binding,records,suite};
 }
 const admissionPolicy:NaiveArtifactStoreDeps['decide']=async(tx,identity,suite)=>{
  const proof=await evidence(tx,identity,suite);if(!proof)return {status:'pending'};
  // Content-address the entire current proof, including revision and completed outputs.
  // Replays are stable; revocation or any retained evidence mutation invalidates the ID.
  return {status:'approved',approvalArtifactId:`${POLICY}:${hash(proof)}`};
 };
 async function authorizeApproval(tx:AgentSqlExecutor,approvalArtifactId:string,identity:NaiveTextDesignIdentity){
  const proof=await evidence(tx,identity);
  if(!proof||approvalArtifactId!==`${POLICY}:${hash(proof)}`)return reject();
 }
 return {admissionPolicy,authorizeApproval};
}
