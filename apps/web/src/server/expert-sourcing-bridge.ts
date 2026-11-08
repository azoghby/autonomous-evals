import 'server-only';
import type { AgentSqlExecutor } from '@ae/core/agents/postgres-ports';
import { inspectDataSafety } from '@ae/core/evals/data/quality';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { decryptJson } from '@ae/core/storage/crypto';
import { credentialSlotsOf, injectCredentials } from '@/server/intake';
import { deriveFactualGapPlan, type FactualGapPlanRequest, type FactualGapProductionInput } from './expert-data-plan';

import { CONSENT_VERSION, DISCLOSURE_TEXT_DIGEST, SHARING_ENVELOPE_VERSION, policyLockIdentity, jobLockIdentity } from './expert-sourcing-store';

const PROFILE='generic-text-factual-gap-v1', DERIVATION='factual_gap_exact_scope.v1';
const fail=(reason='input_binding'):never=>{throw Error(`expert_sourcing_${reason}`);};
export interface DerivedSourcingRequest { request:FactualGapPlanRequest; input:FactualGapProductionInput; targetDigest:string }
/** Caller holds policy then job session mutexes and the canonical job/credential row locks.
 * Every failure throws so a caller cannot accidentally commit partial issuance. */
async function retained(tx:AgentSqlExecutor,args:DerivedSourcingRequest){
 const {request,input,targetDigest}=args;
 const rows=(await tx.query<{kind:string;id:string;state:string;input_digest:string;value:any}>(`SELECT kind,id,state,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind IN ('naive_execution_policy','naive_factual_gap_proposal') ORDER BY kind,id FOR UPDATE`,[request.jobId])).rows;
 if(rows.length!==2||rows.some(r=>r.state!=='completed'||r.input_digest!==reviewDigest(r.value)))return fail();
 const selection=rows.find(r=>r.kind==='naive_execution_policy'&&r.id==='selection-v1')?.value;
 const proposal=rows.find(r=>r.kind==='naive_factual_gap_proposal'&&r.id==='proposal-v1')?.value;
 const identity={jobId:request.jobId,customerId:input.factualGapEntry.tenantId,environment:request.environment};
 if(selection?.schemaVersion!=='naive_text_execution_selection.v1'||proposal?.schemaVersion!=='naive_factual_gap_retention.v1'
  ||reviewDigest(selection.identity)!==reviewDigest(identity)||reviewDigest(proposal.identity)!==reviewDigest(identity)
  ||selection.profile?.policyId!==PROFILE||selection.profile?.designId!==PROFILE||selection.profile?.admissionPolicyId!=='automated-text-design-factual-gap-v1'
  ||selection.profile?.factualGapPolicy!=='propose_missing_reference.v1'||selection.profile?.expertTaskId!==request.taskId||selection.profile?.versionLabel!==request.versionLabel
  ||reviewDigest(proposal.profile)!==reviewDigest(selection.profile)||proposal.canonicalInputDigest!==request.canonicalInputDigest
  ||proposal.targetDigest!==targetDigest||reviewDigest(proposal.proposal)!==reviewDigest(request.proposal))return fail();
}
async function canonical(tx:AgentSqlExecutor,args:DerivedSourcingRequest,decrypt=(s:string)=>decryptJson<Record<string,string>>(s)){
 const {request,input,targetDigest}=args;
 const job=(await tx.query<any>(`SELECT customer_id::text,environment,package,is_mock,state,intake,created_at+interval '7 days'>now() AS before_deadline,(credentials_delete_after IS NULL OR credentials_delete_after>now()) AS credentials_current FROM jobs WHERE id=$1 FOR UPDATE`,[request.jobId])).rows[0];
 if(process.env.EVAL_SERVICES!=='real'||!job||job.customer_id!==input.factualGapEntry.tenantId||job.environment!==request.environment||job.package!=='text_eval'||job.is_mock||!['planning','running','investigating'].includes(job.state)||!job.before_deadline||!job.credentials_current)return fail();
 const credential=(await tx.query<{ciphertext:string}>('SELECT ciphertext FROM job_credentials WHERE job_id=$1 FOR UPDATE',[request.jobId])).rows[0];
 const raw=job.intake;
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||['endpoint','endpointA','endpointB'].some(k=>raw[k]&&typeof raw[k]==='object'&&'apiKey' in raw[k])||raw._credentialSlots!==undefined&&(!Array.isArray(raw._credentialSlots)||raw._credentialSlots.some((s:unknown)=>s!=='endpoint')))return fail();
 let values:Record<string,string>;try{values=credential?decrypt(credential.ciphertext):{};}catch{return fail();}
 if(!values||typeof values!=='object'||Array.isArray(values)||Object.values(values).some(v=>typeof v!=='string')||credentialSlotsOf(raw).some(s=>!values[s]))return fail();
 const endpoint=injectCredentials(raw,values).endpoint as any;
 if(!endpoint||typeof endpoint.url!=='string'||typeof endpoint.model!=='string')return fail();
 const target={url:endpoint.url,model:endpoint.model,...(endpoint.apiKey?{apiKey:endpoint.apiKey}:{}),systemPrompt:endpoint.systemPrompt??''};
 if(reviewDigest(target)!==targetDigest||reviewDigest(deriveFactualGapPlan(request,job,targetDigest))!==reviewDigest(input))return fail();
 const secrets=[...Object.values(values),...Object.entries(process.env).filter(([k])=>/(?:KEY|TOKEN|SECRET|DATABASE_URL)$/.test(k)).map(([,v])=>v??'')].filter(Boolean);
 if(!inspectDataSafety(input,secrets).safe)return fail('unsafe_input');
 await retained(tx,args);
}
type Policy={id:string;tenant_id:string;environment:string;topic:string;caps_policy_id:string;policy_version:string;derivation_version:string;execution_profile:string;sharing_envelope_version:string;max_requirements:number;max_context_chars:number;grant_lifetime_seconds:number};
async function envelope(tx:AgentSqlExecutor,args:DerivedSourcingRequest){
 const {request,input}=args,tenant=input.factualGapEntry.tenantId;
 const policies=(await tx.query<Policy>(`SELECT * FROM expert_sourcing.policies WHERE tenant_id=$1 AND environment=$2 AND revoked_at IS NULL AND issued_at<=now() AND expires_at>now() ORDER BY id FOR UPDATE`,[tenant,request.environment])).rows;
 // Consent selects an owner-configured topic; neither model prose nor intake testing permission does.
 const consents=(await tx.query<any>(`SELECT * FROM expert_sourcing.consents WHERE job_id=$1 AND tenant_id=$2 AND authenticated_customer_id=$2 AND canonical_input_digest=$3 AND revoked_at IS NULL AND issued_at<=now() AND expires_at>now() ORDER BY id FOR UPDATE`,[request.jobId,tenant,request.canonicalInputDigest])).rows;
 if(consents.length!==1)return fail('sharing_consent');
 const consent=consents[0];
 if(consent.consent_version!==CONSENT_VERSION||consent.disclosure_text_digest!==DISCLOSURE_TEXT_DIGEST||consent.sharing_envelope_version!==SHARING_ENVELOPE_VERSION)return fail('sharing_consent');
 const matching=policies.filter(p=>p.topic===consent.topic);
 if(matching.length!==1)return fail('owner_policy');const policy=matching[0];
 if(policy.policy_version!=='expert_sourcing_policy.v1'||policy.sharing_envelope_version!==SHARING_ENVELOPE_VERSION||policy.derivation_version!==DERIVATION||policy.execution_profile!==PROFILE||policy.sharing_envelope_version!==consent.sharing_envelope_version||!policy.topic.trim()||policy.topic!==policy.topic.trim()||policy.topic.length>160
  ||input.task.requirements.length>Math.min(36,policy.max_requirements)||typeof input.context.systemPrompt!=='string'&&input.context.systemPrompt!==null
  ||(input.context.systemPrompt??'').length>policy.max_context_chars||policy.grant_lifetime_seconds<=0)return fail('owner_policy');
 const caps=(await tx.query<any>('SELECT enabled,job_cap_micro_usd::text,daily_cap_micro_usd::text FROM expert_automation_policies WHERE id=$1 FOR UPDATE',[policy.caps_policy_id])).rows[0];
 if(!caps?.enabled||caps.job_cap_micro_usd!=='25000000'||caps.daily_cap_micro_usd!=='50000000')return fail('owner_policy');
 return {policy,consent,requestHash:reviewDigest({task:input.task,topic:policy.topic})};
}
export async function installDerivedSourcingAuthority(tx:AgentSqlExecutor,args:DerivedSourcingRequest,options:{decryptCredentials?:(s:string)=>Record<string,string>;expectedPolicyId:string}):Promise<{topic:string}>{
 await canonical(tx,args,options.decryptCredentials);
 const {policy,consent,requestHash}=await envelope(tx,args),{request,input,targetDigest}=args;
 if(policy.id!==options.expectedPolicyId)return fail('owner_policy');
 const bindings=[request.jobId,request.taskId,input.factualGapEntry.tenantId,request.environment,policy.id,consent.id,policy.topic,reviewDigest(request.proposal),request.canonicalInputDigest,targetDigest,requestHash,DERIVATION,PROFILE,policy.sharing_envelope_version,policy.id];
 const old=(await tx.query<any>('SELECT * FROM expert_sourcing.grants WHERE job_id=$1 AND task_id=$2 FOR UPDATE',bindings.slice(0,2))).rows[0];
 if(!old){
  const scope=(await tx.query('SELECT job_id FROM expert_automation_scopes WHERE job_id=$1 AND task_id=$2 FOR UPDATE',bindings.slice(0,2))).rows;
  if(scope.length)return fail('plan_conflict');
  await tx.query(`INSERT INTO expert_automation_scopes(job_id,task_id,tenant_id,policy_id,topic,request_hash,enabled,customer_sharing_consent,authority_kind) VALUES($1,$2,$3,$4,$5,$6,true,true,'derived_standing_policy')`,[request.jobId,request.taskId,input.factualGapEntry.tenantId,policy.caps_policy_id,policy.topic,requestHash]);
  await tx.query(`INSERT INTO expert_sourcing.grants(job_id,task_id,tenant_id,environment,policy_id,consent_id,topic,proposal_digest,canonical_input_digest,target_digest,request_hash,derivation_version,execution_profile,sharing_envelope_version,issued_by_policy,input_digest,issued_via,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'standing_policy',LEAST(now()+$17*interval '1 second',$18::timestamptz,$19::timestamptz))`,[...bindings,reviewDigest(input),policy.grant_lifetime_seconds,(policy as any).expires_at,consent.expires_at]);
 }
 await validateReceipt(tx,args,policy,consent,requestHash);
 return {topic:policy.topic};
}
async function validateReceipt(tx:AgentSqlExecutor,args:DerivedSourcingRequest,policy:Policy,consent:any,requestHash:string){
 const g=(await tx.query<any>(`SELECT g.*,g.expires_at>now() AND g.issued_at<=now() AS current,s.enabled,s.authority_kind,s.tenant_id AS scope_tenant,s.policy_id AS scope_policy,s.topic AS scope_topic,s.request_hash AS scope_hash,s.customer_sharing_consent FROM expert_sourcing.grants g JOIN expert_automation_scopes s ON s.job_id=g.job_id AND s.task_id=g.task_id WHERE g.job_id=$1 AND g.task_id=$2 FOR UPDATE OF g,s`,[args.request.jobId,args.request.taskId])).rows[0];
 if(g&&!g.enabled)return fail('owner_scope');
 if(g&&!g.customer_sharing_consent)return fail('sharing_consent');
 if(!g||g.input_digest!==reviewDigest(args.input)||!g.current||g.revoked_at||!g.enabled||g.authority_kind!=='derived_standing_policy'||!g.customer_sharing_consent||g.tenant_id!==args.input.factualGapEntry.tenantId||g.scope_tenant!==g.tenant_id||g.environment!==args.request.environment||g.policy_id!==policy.id||g.consent_id!==consent.id||g.scope_policy!==policy.caps_policy_id||g.topic!==policy.topic||g.scope_topic!==policy.topic||g.request_hash!==requestHash||g.scope_hash!==requestHash||g.proposal_digest!==reviewDigest(args.request.proposal)||g.canonical_input_digest!==args.request.canonicalInputDigest||g.target_digest!==args.targetDigest||g.derivation_version!==DERIVATION||g.execution_profile!==PROFILE||g.sharing_envelope_version!==policy.sharing_envelope_version||g.issued_via!=='standing_policy'||g.issued_by_policy!==policy.id)return fail('plan_conflict');
}
/** Same caller mutex/transaction contract as installation. No missing receipt is legacy. */
export async function assertDerivedSourcingAuthorityCurrent(tx:AgentSqlExecutor,jobId:string,taskId:string):Promise<void>{
 const plan=(await tx.query<any>('SELECT input,input_digest,topic,enabled,response_deadline>now() AS current FROM expert_workflow.plans WHERE job_id=$1',[jobId])).rows[0];
 const scope=(await tx.query<any>('SELECT authority_kind FROM expert_automation_scopes WHERE job_id=$1 AND task_id=$2',[jobId,taskId])).rows[0];
 if(!plan||!scope||!plan.enabled||!plan.current)return fail();
 if(scope.authority_kind==='legacy_configured'&&!Object.prototype.hasOwnProperty.call(plan.input??{},'factualGapEntry'))return;
 const input=plan.input as FactualGapProductionInput,entry=input?.factualGapEntry;
 if(!plan.enabled||!plan.current||!entry||reviewDigest(input)!==plan.input_digest||input.task.taskId!==taskId||input.task.jobId!==jobId)return fail();
 const args={request:{jobId,taskId,environment:entry.environment,versionLabel:input.context.versionLabel,proposal:entry.proposal,canonicalInputDigest:entry.canonicalInputDigest},input,targetDigest:entry.targetDigest};
 await canonical(tx,args);const live=await envelope(tx,args);
 if(plan.topic!==live.policy.topic)return fail();
 await validateReceipt(tx,args,live.policy,live.consent,live.requestHash);
}

/** Discovery grants no authority. Revalidate selected policy after taking both mutexes. */
export async function discoverSourcingLockKeys(sql:AgentSqlExecutor,jobId:string):Promise<{policyId:string;keys:string[]}>{
 const consents=(await sql.query('SELECT id FROM expert_sourcing.consents WHERE job_id=$1 AND revoked_at IS NULL AND issued_at<=now() AND expires_at>now()',[jobId])).rows;
 if(consents.length!==1)return fail('sharing_consent');
 const rows=(await sql.query<{id:string}>(`SELECT p.id FROM jobs j JOIN expert_sourcing.consents c ON c.job_id=j.id AND c.tenant_id=j.customer_id AND c.authenticated_customer_id=j.customer_id JOIN expert_sourcing.policies p ON p.tenant_id=j.customer_id AND p.environment=j.environment AND p.topic=c.topic WHERE j.id=$1 AND p.revoked_at IS NULL AND p.expires_at>now() AND c.revoked_at IS NULL AND c.expires_at>now() ORDER BY p.id,c.id`,[jobId])).rows;
 if(rows.length!==1)return fail('owner_policy');
 return {policyId:rows[0].id,keys:[policyLockIdentity(rows[0].id),jobLockIdentity(jobId)]};
}
