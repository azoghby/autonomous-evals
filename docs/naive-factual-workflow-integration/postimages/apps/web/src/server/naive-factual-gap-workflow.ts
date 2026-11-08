import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentSqlExecutor, AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { IntakeInput } from '@ae/core/contracts/index';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { inspectDataSafety } from '@ae/core/evals/data/quality';
import { FactualGapProposalSchema, factualGapInputDigest, type FactualGapProposal } from '@ae/core/evals/text/factual-gap';
import { normalizeReferenceText } from '@ae/core/evals/text/schema';
import { decryptJson } from '@ae/core/storage/crypto';
import type { NaiveTextExecutionIdentity, NaiveTextExecutionProfile } from './naive-text-execution-selection';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const retainedSchema = z.object({schemaVersion:z.literal('naive_factual_gap_retention.v1'),identity:z.object({jobId:z.string().uuid(),customerId:z.string().uuid(),environment:z.enum(['test','live'])}).strict(),profile:z.unknown(),canonicalInputDigest:digest,targetDigest:digest,proposal:FactualGapProposalSchema}).strict();
export interface FactualGapEntryRequest { jobId:string;environment:'test'|'live';taskId:string;versionLabel:string;proposal:FactualGapProposal;canonicalInputDigest:string;expectedTargetDigest:string }
export type FactualGapEntryResult = {status:'installed'|'replayed';inputDigest:string;proposalDigest:string;contactGate:'opted_in'|'cold_approval_required'} | {status:'prerequisite_blocked'|'rejected';reason:string};
type Dependencies = {decryptCredentials?:(ciphertext:string)=>Record<string,string>;installPlan?:(request:FactualGapEntryRequest)=>Promise<FactualGapEntryResult>};
const conflict=():never=>{throw Error('naive_factual_gap_proposal_conflict');};
async function binding(tx:AgentSqlExecutor,identity:NaiveTextExecutionIdentity,profile:NaiveTextExecutionProfile,deps:Dependencies){
 const row=(await tx.query<{customer_id:string;environment:string;package:string;is_mock:boolean;intake:unknown;credentials_current:boolean}>(`SELECT customer_id::text,environment,package,is_mock,intake,(credentials_delete_after IS NULL OR credentials_delete_after>now()) AS credentials_current FROM jobs WHERE id=$1 FOR UPDATE`,[identity.jobId])).rows[0];
 if(!row||row.customer_id!==identity.customerId||row.environment!==identity.environment||row.package!=='text_eval'||row.is_mock||!row.credentials_current||!('expertTaskId' in profile)||profile.policyId!=='generic-text-factual-gap-v1'||profile.factualGapPolicy!=='propose_missing_reference.v1')return conflict();
 const selection=(await tx.query<{state:string;input_digest:string;value:any}>(`SELECT state,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_execution_policy' AND id='selection-v1' FOR UPDATE`,[identity.jobId])).rows[0];
 if(!selection||selection.value?.schemaVersion!=='naive_text_execution_selection.v1'||selection.state!=='completed'||selection.input_digest!==reviewDigest(selection.value)||reviewDigest(selection.value.identity)!==reviewDigest(identity)||reviewDigest(selection.value.profile)!==reviewDigest(profile))return conflict();
 const raw=row.intake as Record<string,any>;
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||['endpoint','endpointA','endpointB'].some(k=>raw[k]&&'apiKey' in raw[k])||raw._credentialSlots!==undefined&&(!Array.isArray(raw._credentialSlots)||raw._credentialSlots.some((s:unknown)=>s!=='endpoint')))return conflict();
 const parsed=IntakeInput.parse(raw);
 if(parsed.package!=='text_eval'||!parsed.authorizedToTest||normalizeReferenceText(parsed.endpoint.referenceText??null)!==null)return conflict();
 const credential=(await tx.query<{ciphertext:string}>('SELECT ciphertext FROM job_credentials WHERE job_id=$1 FOR UPDATE',[identity.jobId])).rows[0];
 let values:Record<string,string>;try{values=credential?(deps.decryptCredentials??decryptJson<Record<string,string>>)(credential.ciphertext):{};}catch{return conflict();}
 if(!values||typeof values!=='object'||Object.values(values).some(v=>typeof v!=='string')||(raw._credentialSlots??[]).some((s:string)=>!values[s]))return conflict();
 const endpoint=parsed.endpoint;
 const canonical={package:parsed.package,authorizedToTest:parsed.authorizedToTest,endpoint:{url:endpoint.url,model:endpoint.model,systemPrompt:endpoint.systemPrompt,referenceText:null},notes:parsed.notes??null};
 const target={url:endpoint.url,model:endpoint.model,...(values.endpoint?{apiKey:values.endpoint}:{}),systemPrompt:endpoint.systemPrompt??''};
 return {canonicalInputDigest:reviewDigest(canonical),targetDigest:reviewDigest(target),systemPrompt:endpoint.systemPrompt,secrets:[...Object.values(values),...Object.entries(process.env).filter(([k])=>/(?:KEY|TOKEN|SECRET|DATABASE_URL)$/.test(k)).map(([,v])=>v??'')].filter(Boolean)};
}
async function load(tx:AgentSqlExecutor,identity:NaiveTextExecutionIdentity){
 const row=(await tx.query<{state:string;input_digest:string;value:unknown}>(`SELECT state,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_factual_gap_proposal' AND id='proposal-v1' FOR UPDATE`,[identity.jobId])).rows[0];
 if(!row)return null;
 const value=retainedSchema.parse(row.value);
 if(row.state!=='completed'||row.input_digest!==reviewDigest(value)||reviewDigest(value.identity)!==reviewDigest(identity))return conflict();
 return value;
}
/** Persist inside a private step before reporting the design failure. No authority is granted. */
export async function retainNaiveFactualGapProposal(sql:AgentTransactionalSql,identity:NaiveTextExecutionIdentity,profile:NaiveTextExecutionProfile,error:{proposal:FactualGapProposal;canonicalInputDigest:string},deps:Dependencies={}){
 return sql.transaction(async tx=>{
  const current=await binding(tx,identity,profile,deps),proposal=FactualGapProposalSchema.parse(error.proposal);
  if(error.canonicalInputDigest!==current.canonicalInputDigest||proposal.inputDigest!==factualGapInputDigest({job:identity,versionLabel:profile.versionLabel,systemPrompt:current.systemPrompt,referenceText:null})||!inspectDataSafety(proposal,current.secrets).safe)return conflict();
  const value=retainedSchema.parse({schemaVersion:'naive_factual_gap_retention.v1',identity,profile,canonicalInputDigest:current.canonicalInputDigest,targetDigest:current.targetDigest,proposal});
  await tx.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_factual_gap_proposal','proposal-v1',$2,$3,'completed',$4::jsonb) ON CONFLICT DO NOTHING`,[identity.jobId,reviewDigest(value),randomUUID(),JSON.stringify(value)]);
  const saved=await load(tx,identity);if(!saved||reviewDigest(saved)!==reviewDigest(value))return conflict();
  return {status:'retained' as const,proposalDigest:reviewDigest(proposal)};
 });
}
/** Call before any paid design/factory. An existing proposal always consumes this path. */
export async function retryNaiveFactualGapEntry(sql:AgentTransactionalSql,identity:NaiveTextExecutionIdentity,profile:NaiveTextExecutionProfile,deps:Dependencies={}):Promise<(FactualGapEntryResult&{proposalRetained?:true})|{status:'absent'}>{
 let request:FactualGapEntryRequest|null;
 try{request=await sql.transaction(async tx=>{
  // Match capture's job → proposal lock order; absence still requires no factual profile.
  await tx.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[identity.jobId]);
  const saved=await load(tx,identity);if(!saved)return null;
  const current=await binding(tx,identity,profile,deps);
  if(reviewDigest(saved.profile)!==reviewDigest(profile)||saved.targetDigest!==current.targetDigest||saved.canonicalInputDigest!==current.canonicalInputDigest||!('expertTaskId' in profile))return conflict();
  return {jobId:identity.jobId,environment:identity.environment,taskId:profile.expertTaskId,versionLabel:profile.versionLabel,proposal:saved.proposal,canonicalInputDigest:saved.canonicalInputDigest,expectedTargetDigest:saved.targetDigest};
 });}catch{return {status:'rejected',reason:'input_binding'};}
 if(!request)return {status:'absent'};
 const install=deps.installPlan??(async(request:FactualGapEntryRequest)=>{return (await import('@/server/expert-data-plan')).installFactualGapExpertPlan(request,{sql,decryptCredentials:deps.decryptCredentials});});
 const result=await install(request);
 // Copy only bounded status metadata across the Workflow boundary.
 if(result.status==='installed'||result.status==='replayed')return {status:result.status,proposalRetained:true,inputDigest:digest.parse(result.inputDigest),proposalDigest:digest.parse(result.proposalDigest),contactGate:z.enum(['opted_in','cold_approval_required']).parse(result.contactGate)};
 const reasons=['real_mode','job_scope','owner_scope','owner_policy','sharing_consent','expert_qualification','credentials','deadline','invalid_proposal','input_binding','unsafe_input','plan_conflict'];
 return {status:result.status,proposalRetained:true,reason:'reason' in result && reasons.includes(result.reason)?result.reason:'input_binding'};
}
