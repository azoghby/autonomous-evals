import 'server-only';
import { Pool } from '@neondatabase/serverless';
import { customerForSessionToken } from '@ae/core/auth/magic-link';
import { isOperator } from '@ae/core/auth/tokens';
import { pooledCalendarDatabase } from '@ae/core/simulator/pool';
import type { AgentSqlExecutor, AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { IntakeInput } from '@ae/core/contracts/index';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { normalizeReferenceText } from '@ae/core/evals/text/schema';
import { decryptJson } from '@ae/core/storage/crypto';
import { credentialSlotsOf } from './intake';
import { getSessionToken } from './session';
import { ExpertSourcingApiError, type ExpertSourcingApiDependencies } from './expert-sourcing-api';
import { withSourcingLocks } from './expert-sourcing-locks';
import { CONSENT_VERSION, SHARING_DISCLOSURE, issueSourcingPolicy, issueSourcingConsent, revokeSourcingPolicy, revokeSourcingConsent, listSourcingConsents, listSourcingPolicies, policyLockIdentity, jobLockIdentity } from './expert-sourcing-store';

const denied = (): never => { throw new ExpertSourcingApiError(409, 'Sourcing authorization unavailable'); };
/** Intentionally uncached: every mutation callback re-reads session validity and operator status. */
export async function freshSourcingViewer() {
  const token = await getSessionToken();
  const customer = token ? await customerForSessionToken(token) : null;
  return customer ? { id: customer.id, email: customer.email, isOperator: isOperator(customer.email) } : null;
}
type Job = { customer_id:string; environment:'test'|'live'; intake:unknown; package:string; is_mock:boolean; state:string; before_deadline:boolean; credentials_current:boolean; deadline:Date|string };
async function ownedJob(tx:AgentSqlExecutor, jobId:string, customerId:string):Promise<Job> {
  const row = (await tx.query<Job>(`SELECT customer_id::text,environment,intake,package,is_mock,state,created_at+interval '7 days' AS deadline,created_at+interval '7 days'>now() AS before_deadline,(credentials_delete_after IS NULL OR credentials_delete_after>now()) AS credentials_current FROM jobs WHERE id=$1 FOR UPDATE`, [jobId])).rows[0];
  if (!row || row.customer_id!==customerId) throw new ExpertSourcingApiError(404, 'Job not found');
  return row;
}
function identity(job:Job) { return { tenantId:job.customer_id, environment:job.environment, canonicalInputDigest:reviewDigest(job.intake) }; }
async function canonical(tx:AgentSqlExecutor, jobId:string, customerId:string) {
  const job=await ownedJob(tx,jobId,customerId);
  if(process.env.EVAL_SERVICES!=='real'||job.package!=='text_eval'||job.is_mock||!['planning','running','investigating'].includes(job.state)||!job.before_deadline||!job.credentials_current)denied();
  const raw=job.intake as Record<string,unknown>;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))denied();
  for(const name of ['endpoint','endpointA','endpointB']){ const endpoint=raw[name]; if(endpoint&&typeof endpoint==='object'&&'apiKey' in endpoint)denied(); }
  if(raw._credentialSlots!==undefined&&(!Array.isArray(raw._credentialSlots)||raw._credentialSlots.some(slot=>slot!=='endpoint')))denied();
  const credential=(await tx.query<{ciphertext:string}>('SELECT ciphertext FROM job_credentials WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
  const values=credential?decryptJson<Record<string,string>>(credential.ciphertext):{};
  if(!values||typeof values!=='object'||Array.isArray(values)||Object.values(values).some(v=>typeof v!=='string')||credentialSlotsOf(raw).some(slot=>!values[slot]))denied();
  const parsed=IntakeInput.parse(raw);
  if(parsed.package!=='text_eval')return denied();
  if(!parsed.authorizedToTest||normalizeReferenceText(parsed.endpoint.referenceText??null)!==null)denied();
  const selection=(await tx.query<{state:string;input_digest:string;value:any}>(`SELECT state,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_execution_policy' AND id='selection-v1' FOR UPDATE`,[jobId])).rows[0];
  const value=selection?.value,profile=value?.profile;
  if(!selection||selection.state!=='completed'||selection.input_digest!==reviewDigest(value)
    ||value?.schemaVersion!=='naive_text_execution_selection.v1'
    ||reviewDigest(value.identity)!==reviewDigest({jobId,customerId,environment:job.environment})
    ||profile?.policyId!=='generic-text-factual-gap-v1'||profile.designId!=='generic-text-factual-gap-v1'
    ||profile.versionLabel!=='generic-text-factual-gap-v1'||profile.admissionPolicyId!=='automated-text-design-factual-gap-v1'
    ||profile.factualGapPolicy!=='propose_missing_reference.v1'||typeof profile.expertTaskId!=='string'
    ||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/.test(profile.expertTaskId))denied();
  return { ...identity(job), canonicalInputDigest:reviewDigest({package:parsed.package,authorizedToTest:parsed.authorizedToTest,endpoint:{url:parsed.endpoint.url,model:parsed.endpoint.model,systemPrompt:parsed.endpoint.systemPrompt,referenceText:normalizeReferenceText(parsed.endpoint.referenceText??null)},notes:parsed.notes??null}), deadline:new Date(job.deadline).toISOString() };
}
let sql:AgentTransactionalSql|undefined;
function database(){
  const connectionString=process.env.DATABASE_URL_UNPOOLED?.trim()||process.env.DATABASE_URL?.trim();
  if(!connectionString)denied();
  return sql??=pooledCalendarDatabase(new Pool({connectionString,max:5}));
}
/** Dependency injection is private server composition for offline verification, never request data. */
export function createSourcingApiDependencies(db:AgentTransactionalSql, viewer=freshSourcingViewer, locks:typeof withSourcingLocks=withSourcingLocks):ExpertSourcingApiDependencies {
  const customerAuth=(customerId:string,current:()=>Promise<string|null>)=>async()=>{
    if(await current()!==customerId||(await viewer())?.id!==customerId)throw new ExpertSourcingApiError(403,'Authentication changed');
    return {customerId};
  };
  const operatorAuth=(current:()=>Promise<string|null>)=>async()=>{
    const id=await current(),fresh=await viewer();
    if(!id||fresh?.id!==id||!fresh.isOperator)throw new ExpertSourcingApiError(403,'Operator access required');
    return {operatorId:id};
  };
  return {
    currentViewer:viewer, disclosure:{version:CONSENT_VERSION,text:SHARING_DISCLOSURE},
    async getSharingStatus({jobId,customerId}) { return db.transaction(async tx=>{
      const fresh=await viewer(); if(fresh?.id!==customerId)throw new ExpertSourcingApiError(403,'Authentication changed');
      let job:Job;try{job=await ownedJob(tx,jobId,customerId);}catch(error){if(error instanceof ExpertSourcingApiError&&error.status===404)return null;throw error;}
      const auth=async()=>({customerId}),validate=async()=>identity(job);
      const rows=await listSourcingConsents(tx,jobId,auth,validate);
      let binding:Awaited<ReturnType<typeof canonical>>|null=null;
      try{binding=await canonical(tx,jobId,customerId);}catch{/* Preserve access to existing consent and revocation even when execution is unavailable. */}
      const topics=binding?await listSourcingPolicies(tx,{tenantId:customerId,environment:job.environment},auth):[];
      const eligibleTopics=[...new Set(topics.map(r=>String((r as Record<string,unknown>).topic)))];
      const latest=rows.at(-1) as Record<string,unknown>|undefined;
      if(!latest)return {status:'not_consented',topic:null,eligibleTopics};
      let status:'active'|'revoked'|'expired'|'input_changed'='active';
      if(latest.revoked_at)status='revoked'; else if(new Date(String(latest.expires_at)).getTime()<=Date.now())status='expired';
      else if(!binding||binding.canonicalInputDigest!==latest.canonical_input_digest)status='input_changed';
      return {status,topic:String(latest.topic),eligibleTopics};
    }); },
    async issueConsent(input){
      if(input.disclosureVersion!==CONSENT_VERSION)denied();
      const selected=(await db.query<{id:string}>(`SELECT p.id FROM jobs j JOIN expert_sourcing.policies p ON p.tenant_id=j.customer_id AND p.environment=j.environment WHERE j.id=$1 AND j.customer_id=$2 AND p.topic=$3 AND p.revoked_at IS NULL AND p.expires_at>now()`,[input.jobId,input.customerId,input.topic])).rows;
      if(selected.length!==1)denied();
      await locks([policyLockIdentity(selected[0]!.id),jobLockIdentity(input.jobId)],async assertHeld=>db.transaction(async tx=>{
        const auth=customerAuth(input.customerId,input.currentCustomer);await auth();
        const binding=await canonical(tx,input.jobId,input.customerId);
        const policies=(await tx.query<{id:string;expires_at:Date|string}>(`SELECT id,expires_at FROM expert_sourcing.policies WHERE tenant_id=$1 AND environment=$2 AND topic=$3 AND revoked_at IS NULL AND expires_at>now() ORDER BY id FOR UPDATE`,[input.customerId,binding.environment,input.topic])).rows;
        if(policies.length!==1||policies[0]!.id!==selected[0]!.id)denied();
        const caps=(await tx.query<{enabled:boolean;job_cap_micro_usd:string;daily_cap_micro_usd:string}>(`SELECT c.enabled,c.job_cap_micro_usd::text,c.daily_cap_micro_usd::text FROM expert_automation_policies c JOIN expert_sourcing.policies p ON p.caps_policy_id=c.id WHERE p.id=$1 FOR UPDATE OF c`,[selected[0]!.id])).rows[0];
        if(!caps?.enabled||caps.job_cap_micro_usd!=='25000000'||caps.daily_cap_micro_usd!=='50000000')denied();
        const expiresAt=new Date(Math.min(Date.parse(binding.deadline),new Date(policies[0]!.expires_at).getTime())).toISOString();
        await assertHeld();
        await issueSourcingConsent(tx,{jobId:input.jobId,topic:input.topic,accepted:true,canonicalInputDigest:binding.canonicalInputDigest,expiresAt},auth,(tx,id)=>canonical(tx,id,input.customerId));
        await assertHeld();
      }));
    },
    async revokeConsent(input){await locks([jobLockIdentity(input.jobId)],async assertHeld=>db.transaction(async tx=>{
      const auth=customerAuth(input.customerId,input.currentCustomer);await auth();
      const validate=async(tx:AgentSqlExecutor,id:string)=>identity(await ownedJob(tx,id,input.customerId));
      const rows=await listSourcingConsents(tx,input.jobId,auth,validate);
      for(const row of rows)await revokeSourcingConsent(tx,{jobId:input.jobId,consentId:String((row as Record<string,unknown>).id),reason:'Customer revoked sharing consent'},auth,validate);
      await assertHeld();
    }));},
    async getPolicies({tenantId}){
      if(!(await viewer())?.isOperator)throw new ExpertSourcingApiError(403,'Operator access required');
      return (await db.query<{id:string;topic:string;environment:'test'|'live';expires_at:Date|string;revoked_at:unknown}>(`SELECT id,topic,environment,expires_at,revoked_at FROM expert_sourcing.policies WHERE tenant_id=$1 ORDER BY issued_at DESC,id LIMIT 100`,[tenantId])).rows.map(r=>({id:r.id,topic:r.topic,environment:r.environment,status:r.revoked_at?'revoked':new Date(r.expires_at).getTime()<=Date.now()?'expired':'active',expiresAt:new Date(r.expires_at).toISOString()}));
    },
    async issuePolicy(input){
      const {currentOperator,...policy}=input;
      // Serialize initial issuance where no policy UUID exists yet. Existing policy dispatch uses its UUID.
      await locks([policyLockIdentity(reviewDigest({tenantId:input.tenantId,environment:input.environment,topic:input.topic}))],async assertHeld=>db.transaction(async tx=>{
        await issueSourcingPolicy(tx,policy,operatorAuth(currentOperator));await assertHeld();
      }));
    },
    async revokePolicy(input){await locks([policyLockIdentity(input.policyId)],async assertHeld=>db.transaction(async tx=>{
      await revokeSourcingPolicy(tx,{policyId:input.policyId,reason:input.reason},operatorAuth(input.currentOperator));await assertHeld();
    }));},
  };
}
export function sourcingApiDependencies():ExpertSourcingApiDependencies { return createSourcingApiDependencies(database()); }
