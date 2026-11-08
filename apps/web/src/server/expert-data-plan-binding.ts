import 'server-only';
import { assertDerivedSourcingAuthorityCurrent } from './expert-sourcing-bridge';
import { z } from 'zod';
import type { AgentSqlExecutor } from '@ae/core/agents/postgres-ports';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { FactualGapProposalSchema } from '@ae/core/evals/text/factual-gap';
import { decryptJson } from '@ae/core/storage/crypto';
import { credentialSlotsOf, injectCredentials } from '@/server/intake';
import { deriveFactualGapPlan } from './expert-data-plan';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const Entry=z.object({schemaVersion:z.literal('factual_gap_plan.v1'),proposal:FactualGapProposalSchema,
 proposalDigest:digest,canonicalInputDigest:digest,targetDigest:digest,environment:z.enum(['test','live']),tenantId:z.uuid()}).strict();
const fail=():never=>{throw new Error('factual_gap_plan_binding_revoked');};
/** Recheck the immutable factual-entry authority at EVERY downstream current-authority
 * boundary. Non-factual legacy plans require an explicit legacy scope discriminator.
 * This guard reads only; it never changes a plan, stores a key, or grants send authority. */
export async function assertFactualGapPlanCurrent(sql:AgentSqlExecutor,jobId:string,options:{decryptCredentials?:(ciphertext:string)=>Record<string,string>}={}):Promise<void>{
 const row=(await sql.query<{input:unknown;input_digest:string;tenant_id:string;customer_id:string;environment:'test'|'live';intake:unknown;package:string;is_mock:boolean;state:string;enabled:boolean;before_deadline:boolean;credentials_current:boolean;topic:string}>(
  `SELECT p.input,p.input_digest,p.tenant_id::text,p.enabled,p.topic,p.response_deadline>now() AS before_deadline,
   j.customer_id::text,j.environment,j.intake,j.package,j.is_mock,j.state,
   (j.credentials_delete_after IS NULL OR j.credentials_delete_after>now()) AS credentials_current
   FROM expert_workflow.plans p JOIN jobs j ON j.id=p.job_id WHERE p.job_id=$1`,[jobId])).rows[0];
 if(!row)return fail();
 if(!row.input||typeof row.input!=='object'||Array.isArray(row.input))return fail();
 if(!Object.prototype.hasOwnProperty.call(row.input,'factualGapEntry')){
  const taskId=(row.input as {task?:{taskId?:unknown}}).task?.taskId;
  if(typeof taskId!=='string')return fail();
  // Missing factual metadata is legacy only when the scope explicitly says so.
  await assertDerivedSourcingAuthorityCurrent(sql,jobId,taskId);return;
 }
 const input=row.input as {factualGapEntry:unknown;task?:{taskId?:unknown};context?:{versionLabel?:unknown}};
 const metadata=Entry.safeParse(input.factualGapEntry);if(!metadata.success)return fail();const entry=metadata.data;
 if(process.env.EVAL_SERVICES!=='real'||!row.enabled||!row.before_deadline||!row.credentials_current||row.package!=='text_eval'||row.is_mock
  ||!['planning','running','investigating'].includes(row.state)||row.tenant_id!==row.customer_id||entry.tenantId!==row.customer_id||entry.environment!==row.environment
  ||reviewDigest(row.input)!==row.input_digest||reviewDigest(entry.proposal)!==entry.proposalDigest)return fail();
 if(!row.intake||typeof row.intake!=='object'||Array.isArray(row.intake))return fail();
 const intake=row.intake as Record<string,unknown>;
 for(const slot of ['endpoint','endpointA','endpointB']){const endpoint=intake[slot];if(endpoint&&typeof endpoint==='object'&&'apiKey' in endpoint)return fail();}
 if(intake._credentialSlots!==undefined&&(!Array.isArray(intake._credentialSlots)||intake._credentialSlots.some(s=>s!=='endpoint')))return fail();
 const credential=(await sql.query<{ciphertext:string}>('SELECT ciphertext FROM job_credentials WHERE job_id=$1',[jobId])).rows[0];
 let values:Record<string,string>;
 try{values=credential?(options.decryptCredentials??decryptJson<Record<string,string>>)(credential.ciphertext):{};}catch{return fail();}
 if(!values||typeof values!=='object'||Array.isArray(values)||Object.values(values).some(v=>typeof v!=='string')||credentialSlotsOf(intake).some(s=>!values[s]))return fail();
 const endpoint=injectCredentials(intake,values).endpoint as {url?:unknown;model?:unknown;apiKey?:unknown;systemPrompt?:unknown}|undefined;
 if(!endpoint||typeof endpoint.url!=='string'||typeof endpoint.model!=='string'||endpoint.apiKey!==undefined&&typeof endpoint.apiKey!=='string')return fail();
 const target={url:endpoint.url,model:endpoint.model,...(endpoint.apiKey?{apiKey:endpoint.apiKey}:{}),systemPrompt:endpoint.systemPrompt??''};
 if(reviewDigest(target)!==entry.targetDigest||typeof input.task?.taskId!=='string'||typeof input.context?.versionLabel!=='string')return fail();
 let expected:unknown;
 try{expected=deriveFactualGapPlan({jobId,environment:row.environment,taskId:input.task.taskId,versionLabel:input.context.versionLabel,
  proposal:entry.proposal,canonicalInputDigest:entry.canonicalInputDigest},{customer_id:row.customer_id,intake:row.intake},entry.targetDigest);}catch{return fail();}
 if(reviewDigest(expected)!==row.input_digest)return fail();
 await assertDerivedSourcingAuthorityCurrent(sql,jobId,input.task.taskId);
 const authority=(await sql.query<{tenant_id:string;request_hash:string;topic:string;enabled:boolean;customer_sharing_consent:boolean;policy_enabled:boolean;job_cap:string;daily_cap:string}>(
  `SELECT s.tenant_id::text,s.request_hash,s.topic,s.enabled,s.customer_sharing_consent,p.enabled AS policy_enabled,
   p.job_cap_micro_usd::text AS job_cap,p.daily_cap_micro_usd::text AS daily_cap
   FROM expert_automation_scopes s JOIN expert_automation_policies p ON p.id=s.policy_id WHERE s.job_id=$1 AND s.task_id=$2`,[jobId,input.task.taskId])).rows[0];
 if(!authority||!authority.enabled||!authority.policy_enabled||!authority.customer_sharing_consent||authority.tenant_id!==row.customer_id||authority.topic!==row.topic
  ||authority.request_hash!==reviewDigest({task:(expected as {task:unknown}).task,topic:row.topic})||authority.job_cap!=='25000000'||authority.daily_cap!=='50000000')return fail();
}
