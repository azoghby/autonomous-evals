import { assertDerivedSourcingAuthorityCurrent, discoverSourcingLockKeys } from './expert-sourcing-bridge';
import { withSourcingLocks } from './expert-sourcing-locks';
import { isOperator } from '@ae/core/auth/tokens';
import { Pool } from '@neondatabase/serverless';
import { randomBytes, createHash } from 'node:crypto';
import { sendEmail as applicationSendEmail } from '@ae/core/auth/email';
import type { AgentSqlExecutor, AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { inspectDataSafety } from '@ae/core/evals/data/quality';
import { redactSecrets } from '@ae/core/agents/redact';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { createAutomatedExpertAdapter, type AutomatedExpertOwnerPorts, type ExpertLoopScope, type ExpertInvitation } from '@ae/core/evals/data/adapters/automated-expert';
import type { BudgetLedger } from '@ae/core/evals/types';
import { createExpertPromiseReservation, createPostgresExpertLoopStore } from '@ae/core/evals/data/adapters/postgres-expert-loop';
import { COLD_CONTACTS_PER_DAY, buildInviteEmail } from './experts-logic';

export interface SqlExpertOwnerOptions {
 ledger: (tx: AgentSqlExecutor) => BudgetLedger; scope: ExpertLoopScope; tenantId: string; topic: string; appUrl: string; companyAddress: string;
 contributions: AutomatedExpertOwnerPorts['contributions'];
 sendEmail?: typeof applicationSendEmail; knownSecrets?: readonly string[] | (() => readonly string[] | Promise<readonly string[]>);
}
const denied = (): never => { throw Error('expert_owner_denied_or_conflict'); };
/** Explicit legacy scopes alone may omit the derived receipt. Factual metadata always wins. */
async function derivedScope(tx:AgentSqlExecutor,jobId:string,taskId:string):Promise<boolean>{
 const row=(await tx.query<{authority_kind:string;factual:boolean}>(`SELECT s.authority_kind,coalesce(p.input ? 'factualGapEntry',false) AS factual FROM expert_automation_scopes s LEFT JOIN expert_workflow.plans p ON p.job_id=s.job_id WHERE s.job_id=$1 AND s.task_id=$2`,[jobId,taskId])).rows[0];
 if(!row)denied();
 if(row.authority_kind==='legacy_configured'&&!row.factual)return false;
 if(row.authority_kind!=='derived_standing_policy'&&!row.factual)denied();
 return true;
}
async function currentSourcing(tx:AgentSqlExecutor,jobId:string,taskId:string){
 if(await derivedScope(tx,jobId,taskId))await assertDerivedSourcingAuthorityCurrent(tx,jobId,taskId);
}
/** Discovery is only a hint; compare again while holding policy then job mutexes. */
async function sourcingDispatch<T>(sql:AgentTransactionalSql,scope:ExpertLoopScope,work:(assertHeld:()=>Promise<void>)=>Promise<T>):Promise<T>{
 if(!await derivedScope(sql,scope.jobId,scope.taskId))return work(async()=>{});
 const selected=await discoverSourcingLockKeys(sql,scope.jobId);
 return withSourcingLocks(selected.keys,async assertHeld=>{
  const current=await discoverSourcingLockKeys(sql,scope.jobId);
  if(current.policyId!==selected.policyId)denied();
  return work(assertHeld);
 });
}
type Authority = { policy_id:string; customer_sharing_consent:boolean; day_scope:string; knownSecrets:readonly string[] };
type Contact = {id:string;email:string;name:string;source:string;consent_flags:{contactForPaidWork?:boolean};allowed_uses:string[]};
/** Concrete owner SQL boundary. One invocation advances the existing adapter once; no scheduler,
 * evaluator, provider search or payment is introduced here. SQL transactions must not retry callbacks. */
export function createSqlExpertOwner(sql: AgentTransactionalSql, options: SqlExpertOwnerOptions): AutomatedExpertOwnerPorts {
 const scope=structuredClone(options.scope);
 async function currentSecrets():Promise<readonly string[]> {
  const value=typeof options.knownSecrets==='function'?await options.knownSecrets():options.knownSecrets??[];
  if(!Array.isArray(value)||value.some(secret=>typeof secret!=='string'||secret.length<4))denied();
  return [...value];
 }
 function safe(value:unknown,secrets:readonly string[]) { if(!inspectDataSafety(value,secrets).safe)denied(); }
 function same(s:ExpertLoopScope) { if(reviewDigest({jobId:s.jobId,taskId:s.taskId,operationId:s.operationId,requestHash:s.requestHash})!==reviewDigest(scope))denied(); }
 async function authority(tx:AgentSqlExecutor,s:ExpertLoopScope):Promise<Authority> {
  same(s);
  await currentSourcing(tx,s.jobId,s.taskId);
  const secrets=await currentSecrets();safe(s,secrets);
  const r=(await tx.query<Authority>(`SELECT s.policy_id,s.customer_sharing_consent,
   coalesce(o.first_promise_day,CURRENT_DATE)::text AS day_scope
   FROM expert_automation_scopes s JOIN jobs j ON j.id=s.job_id AND j.customer_id=s.tenant_id
   JOIN expert_automation_policies p ON p.id=s.policy_id
   LEFT JOIN expert_automation_operations o ON o.operation_id=$5
   WHERE s.job_id=$1 AND s.task_id=$2 AND s.tenant_id=$3 AND s.request_hash=$4
   AND j.state NOT IN ('cancelled','failed','delivered','paused_budget','payment_review')
   AND s.topic=$6 AND s.enabled AND p.enabled AND p.job_cap_micro_usd=25000000 AND p.daily_cap_micro_usd=50000000`,
   [s.jobId,s.taskId,options.tenantId,s.requestHash,s.operationId,options.topic])).rows[0];
  if(!r)denied();return {...r,knownSecrets:secrets};
 }
 async function operation(tx:AgentSqlExecutor) {
  const r=(await tx.query<{request_id:string;job_id:string;task_id:string;tenant_id:string;request_hash:string}>(
   'SELECT * FROM expert_automation_operations WHERE operation_id=$1 FOR UPDATE',[scope.operationId])).rows[0];
  if(!r||r.job_id!==scope.jobId||r.task_id!==scope.taskId||r.tenant_id!==options.tenantId||r.request_hash!==scope.requestHash)denied();return r;
 }
 async function contact(tx:AgentSqlExecutor,id:string):Promise<Contact> {
  const r=(await tx.query<Contact>(`SELECT e.*,q.allowed_uses FROM experts e JOIN expert_automation_qualifications q ON q.expert_id=e.id
   WHERE e.id=$1 AND q.topic=$2 AND q.qualified AND jsonb_array_length(q.evidence)>0 AND length(q.consent_receipt)>0
   AND e.status='active' AND NOT EXISTS(SELECT 1 FROM contact_suppressions x WHERE lower(x.email)=lower(e.email)) FOR UPDATE OF e,q`,[id,options.topic])).rows[0];
  if(!r)denied();return r;
 }
 function opted(c:Contact){return c.source==='opt_in'&&c.consent_flags.contactForPaidWork===true;}
 async function prepare(tx:AgentSqlExecutor,c:Contact,inv:ExpertInvitation,coldQueue=false) {
  const op=await operation(tx), digest=reviewDigest(inv);
  let r=(await tx.query<{engagement_id:string;draft_id:string;invitation_digest:string;promised:boolean;send_state:string}>(
   'SELECT * FROM expert_automation_invitations WHERE operation_id=$1 AND expert_id=$2 FOR UPDATE',[scope.operationId,c.id])).rows[0];
  if(r){if(coldQueue)return r;if(r.invitation_digest!==digest){
   if(r.promised||r.send_state!=='prepared')denied();
   if(inv.questions.length>8||inv.questions.some(q=>q.length>1000)||inv.requiredUses.some(u=>!c.allowed_uses.includes(u)))denied();
   await tx.query(`UPDATE outreach_drafts SET body=regexp_replace(body,'answer [0-9]+ short questions?','answer ' || $1::text || ' short questions') WHERE id=$2`,[inv.questions.length,r.draft_id]);
   await tx.query('UPDATE expert_automation_invitations SET invitation_digest=$1 WHERE engagement_id=$2',[digest,r.engagement_id]);
   await tx.query('UPDATE expert_requests SET questions=$1::jsonb WHERE id=$2',[JSON.stringify(inv.questions),op.request_id]);
  }return r;}
  if(inv.questions.length>8||inv.questions.some(q=>q.length>1000)||inv.honorariumMicroUsd%10000!==0||inv.requiredUses.some(u=>!c.allowed_uses.includes(u)))denied();
  const token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');
  const email=buildInviteEmail({expertName:c.name,domain:options.topic,purpose:'Contribute independently verifiable evaluation cases.',questionCount:inv.questions.length,honorariumCents:inv.honorariumMicroUsd/10000,questionnaireUrl:`${options.appUrl}/expert/r/${token}`,optOutUrl:`${options.appUrl}/expert/opt-out/${token}`,companyAddress:options.companyAddress});
  const draft=(await tx.query<{id:string}>(`INSERT INTO outreach_drafts(to_email,subject,body,status,kind) VALUES($1,$2,$3,'pending','expert_invite') RETURNING id`,[c.email,email.subject,email.body])).rows[0]!;
  const engagement=(await tx.query<{id:string}>(`INSERT INTO expert_engagements(request_id,expert_id,token_hash,expires_at,honorarium_cents,outreach_draft_id) VALUES($1,$2,$3,now()+interval '7 days',$4,$5) RETURNING id`,[op.request_id,c.id,hash,inv.honorariumMicroUsd/10000,draft.id])).rows[0]!;
  if(!coldQueue)await tx.query('UPDATE expert_requests SET questions=$1::jsonb WHERE id=$2',[JSON.stringify(inv.questions),op.request_id]);
  await tx.query(`INSERT INTO expert_automation_invitations(operation_id,expert_id,engagement_id,draft_id,invitation_digest,amount_micro_usd) VALUES($1,$2,$3,$4,$5,$6)`,[scope.operationId,c.id,engagement.id,draft.id,digest,inv.honorariumMicroUsd]);
  return {engagement_id:engagement.id,draft_id:draft.id,invitation_digest:digest};
 }
 const store=createPostgresExpertLoopStore(sql,{tenantId:options.tenantId,scope,authorize:async(tx,s)=>{const a=await authority(tx,s);return {allowed:true,knownSecrets:a.knownSecrets};}});
 const owner:AutomatedExpertOwnerPorts={store,
  authorize:async s=>sql.transaction(async tx=>{const a=await authority(tx,s);const approved=await tx.query<{expert_id:string;founder_approved_by:string}>(`SELECT expert_id,founder_approved_by FROM expert_automation_invitations i JOIN outreach_drafts d ON d.id=i.draft_id WHERE i.operation_id=$1 AND i.founder_approved_by IS NOT NULL AND d.status='approved'`,[s.operationId]);return {allowed:true,policyId:a.policy_id,dayScope:a.day_scope,customerSharingConsent:a.customer_sharing_consent,approvedColdContactIds:approved.rows.filter(r=>isOperator(r.founder_approved_by)).map(r=>r.expert_id),knownSecrets:a.knownSecrets};}),
  ensureRequest:async s=>sql.transaction(async tx=>{await authority(tx,s);await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`expert-operation:${s.operationId}`]);const found=(await tx.query('SELECT operation_id FROM expert_automation_operations WHERE operation_id=$1',[s.operationId])).rows[0];if(found){await operation(tx);return;}
   const r=(await tx.query<{id:string}>(`INSERT INTO expert_requests(job_id,domain,questions,purpose,max_budget_cents) VALUES($1,$2,'[]'::jsonb,'Independent evaluation cases',2500) RETURNING id`,[s.jobId,options.topic])).rows[0]!;
   await tx.query('INSERT INTO expert_automation_operations(operation_id,job_id,task_id,tenant_id,request_hash,request_id) VALUES($1,$2,$3,$4,$5,$6)',[s.operationId,s.jobId,s.taskId,options.tenantId,s.requestHash,r.id]);}),
  discover:async(s,q)=>sql.transaction(async tx=>{await authority(tx,s);await operation(tx);if(q.topic!==options.topic||q.limit>10)denied();
   const rows=await tx.query<{id:string}>(`SELECT e.id FROM experts e JOIN expert_automation_qualifications q ON q.expert_id=e.id WHERE q.topic=$1 AND q.qualified AND e.status='active' ORDER BY (e.source='opt_in') DESC,e.id LIMIT $2`,[q.topic,q.limit]);
   const out=[];for(const row of rows.rows){let c:Contact;try{c=await contact(tx,row.id);}catch{continue;}
    if(!opted(c)) { // Actual founder queue; this record confers no send permission or promise.
     await prepare(tx,c,{requestId:s.operationId,contactId:c.id,questions:[`Subject: ${options.topic}`,'Provide representative independently verifiable cases, source permissions, and limitations.'],requiredUses:['evaluation'],honorariumMicroUsd:25000000,sharesCustomerScope:false},true);
    }
    out.push({id:c.id,qualified:true,optedIn:opted(c),honorariumMicroUsd:25000000});
   }return out;}),
  reserve:async(s,input)=>{same(s);const row=await store.get(s.operationId);const retainedInvitation=row?.invitation;if(!retainedInvitation) return denied();return sql.transaction(async tx=>{
   const a=await authority(tx,s),c=await contact(tx,input.contactId),inv=retainedInvitation;safe(inv,a.knownSecrets);
   if(a.policy_id!==input.policyId||a.day_scope!==input.dayScope||input.jobCapMicroUsd!==25000000||input.dailyCapMicroUsd!==50000000||input.amountMicroUsd!==inv.honorariumMicroUsd||inv.contactId!==c.id||inv.sharesCustomerScope&&!a.customer_sharing_consent)denied();
   const prepared=await prepare(tx,c,inv);
   const approved=(await tx.query<{founder_approved_by:string|null}>(`SELECT i.founder_approved_by FROM expert_automation_invitations i JOIN outreach_drafts d ON d.id=i.draft_id WHERE i.engagement_id=$1 AND (i.founder_approved_by IS NULL OR d.status='approved')`,[prepared.engagement_id])).rows[0]!;
   if(!opted(c)&&(!approved?.founder_approved_by||!isOperator(approved.founder_approved_by)))denied();
   await tx.query("SELECT pg_advisory_xact_lock(hashtext('expert-company-promises'))");
   const existing=(await tx.query<{promised:boolean;promise_key:string}>('SELECT promised,promise_key FROM expert_automation_invitations WHERE engagement_id=$1 FOR UPDATE',[prepared.engagement_id])).rows[0]!;
   if(existing.promised){if(existing.promise_key!==input.key)denied();return true;}
   const totals=(await tx.query<{job:string;day:string}>(`SELECT coalesce(sum(i.amount_micro_usd) FILTER(WHERE o.job_id=$1),0)::text AS job,coalesce(sum(i.amount_micro_usd) FILTER(WHERE i.promise_day=$2::date),0)::text AS day FROM expert_automation_invitations i JOIN expert_automation_operations o USING(operation_id) WHERE i.promised`,[s.jobId,a.day_scope])).rows[0]!;
   if(Number(totals.job)+input.amountMicroUsd>25000000||Number(totals.day)+input.amountMicroUsd>50000000)return false;
   await tx.query('UPDATE expert_automation_operations SET first_promise_day=coalesce(first_promise_day,$1::date) WHERE operation_id=$2',[a.day_scope,s.operationId]);
   const reserveShared=createExpertPromiseReservation(options.ledger(tx),{dayScope:a.day_scope,authorize:async current=>{const auth=await authority(tx,current);return {allowed:true,policyId:auth.policy_id,dayScope:auth.day_scope};}});
   if(!await reserveShared(s,input))return false;
   await tx.query('UPDATE expert_automation_invitations SET promised=true,promise_day=$1::date,promise_key=$2 WHERE engagement_id=$3',[a.day_scope,input.key,prepared.engagement_id]);return true;});},
  invite:async(s,inv,key)=>sourcingDispatch(sql,s,async assertHeld=>{
   await store.get(s.operationId);
   const claim=await sql.transaction(async tx=>{const a=await authority(tx,s),c=await contact(tx,inv.contactId);safe(inv,a.knownSecrets);await operation(tx);
    const r=(await tx.query<{engagement_id:string;draft_id:string;invitation_digest:string;promised:boolean;promise_key:string;founder_approved_by:string|null;send_state:string;subject:string;body:string;status:string;to_email:string;engagement_status:string}>(`SELECT i.*,d.subject,d.body,d.status,d.to_email,e.status AS engagement_status FROM expert_automation_invitations i JOIN outreach_drafts d ON d.id=i.draft_id JOIN expert_engagements e ON e.id=i.engagement_id WHERE i.operation_id=$1 AND i.expert_id=$2 AND e.expires_at>now() FOR UPDATE OF i,d,e`,[s.operationId,c.id])).rows[0];
    if(!r||!r.promised||r.promise_key!==key||r.invitation_digest!==reviewDigest(inv)||r.engagement_status!=='invited'||r.status==='rejected'||r.to_email!==c.email||inv.sharesCustomerScope&&!a.customer_sharing_consent||!opted(c)&&(r.status!=='approved'||!r.founder_approved_by||!isOperator(r.founder_approved_by)))denied();
    if(r.send_state!=='prepared')return null;
    await tx.query("UPDATE expert_automation_invitations SET send_state='claimed' WHERE engagement_id=$1",[r.engagement_id]);return r;});
   if(!claim)return {status:'ambiguous'};
   try {await sql.transaction(async tx=>{const a=await authority(tx,s),c=await contact(tx,inv.contactId);safe(inv,a.knownSecrets);await operation(tx);
    const r=(await tx.query<{engagement_id:string;draft_id:string;invitation_digest:string;promised:boolean;promise_key:string;founder_approved_by:string|null;send_state:string;subject:string;body:string;status:string;to_email:string;engagement_status:string}>(`SELECT i.*,d.subject,d.body,d.status,d.to_email,e.status AS engagement_status FROM expert_automation_invitations i JOIN outreach_drafts d ON d.id=i.draft_id JOIN expert_engagements e ON e.id=i.engagement_id WHERE i.operation_id=$1 AND i.expert_id=$2 AND e.expires_at>now() FOR UPDATE OF i,d,e`,[s.operationId,c.id])).rows[0];
    if(!r||!r.promised||r.promise_key!==key||r.invitation_digest!==reviewDigest(inv)||r.engagement_status!=='invited'||r.status==='rejected'||r.to_email!==c.email||inv.sharesCustomerScope&&!a.customer_sharing_consent||!opted(c)&&(r.status!=='approved'||!r.founder_approved_by||!isOperator(r.founder_approved_by)))denied();
    if(r.send_state!=='claimed'||r.subject!==claim.subject||r.body!==claim.body||r.draft_id!==claim.draft_id||r.engagement_id!==claim.engagement_id)denied();
    if(redactSecrets(JSON.stringify({subject:claim.subject,text:claim.body}),a.knownSecrets).redactions>0)denied();});await assertHeld();const receipt=await (options.sendEmail??applicationSendEmail)({purpose:'commercial',to:claim.to_email,subject:claim.subject,text:claim.body});
    await sql.transaction(async tx=>{await tx.query("UPDATE expert_automation_invitations SET send_state='sent',message_id=$1,thread_id=$2 WHERE engagement_id=$3 AND send_state='claimed'",[receipt.id??null,receipt.threadId??null,claim.engagement_id]);await tx.query("UPDATE outreach_drafts SET status='sent',sent_at=now() WHERE id=$1",[claim.draft_id]);});return {status:'sent',deliveryId:claim.engagement_id};
   }catch{return {status:'ambiguous'};}
  }),
  recoverDelivery:async(s,key)=>{await store.get(s.operationId);return sql.transaction(async tx=>{await authority(tx,s);await operation(tx);const r=(await tx.query<{send_state:string;engagement_id:string}>('SELECT send_state,engagement_id FROM expert_automation_invitations WHERE operation_id=$1 AND promise_key=$2',[s.operationId,key])).rows[0];return r?.send_state==='sent'?{status:'sent',deliveryId:r.engagement_id}:null;});},
  contributions:async(s,deliveryId)=>{await sql.transaction(async tx=>{await authority(tx,s);await operation(tx);const r=(await tx.query('SELECT engagement_id FROM expert_automation_invitations WHERE operation_id=$1 AND engagement_id=$2 AND send_state=\'sent\'',[s.operationId,deliveryId])).rows[0];if(!r)denied();});const values=await options.contributions(s,deliveryId);await sql.transaction(async tx=>{const a=await authority(tx,s);safe(values,a.knownSecrets);});return values;},
 };return owner;
}
/** Mount in the existing acquisition Workflow, once per durable acquisition operation. */
export function createOwnerExpertStep(sql:AgentTransactionalSql,options:SqlExpertOwnerOptions){return createAutomatedExpertAdapter(createSqlExpertOwner(sql,options),{topic:options.topic});}

/** Authenticated founder action records contact approval only. The existing Workflow performs
 * budget reservation and dispatch through the durable claim. Never fabricates approved_by. */
export async function approveSqlManagedExpertDraft(sql:AgentTransactionalSql,id:string,operatorEmail:string):Promise<boolean>{
 return sql.transaction(async tx=>{
  const row=(await tx.query<{draft_id:string;job_id:string;task_id:string}>("SELECT i.draft_id,o.job_id,o.task_id FROM expert_automation_invitations i JOIN expert_automation_operations o USING(operation_id) WHERE i.draft_id=$1",[id])).rows[0];
  if(!row)return false;
  if(!isOperator(operatorEmail))denied();
  await currentSourcing(tx,row.job_id,row.task_id);
  await tx.query("SELECT draft_id FROM expert_automation_invitations WHERE draft_id=$1 FOR UPDATE",[id]);
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('expert-cold-contact-approvals'))");
  const source=(await tx.query<{source:string}>(`SELECT e.source FROM expert_automation_invitations i JOIN experts e ON e.id=i.expert_id WHERE i.draft_id=$1`,[id])).rows[0];
  if(source?.source==='agent_researched'){
   const count=(await tx.query<{n:string}>(`SELECT count(*)::text AS n FROM expert_engagements e JOIN experts x ON x.id=e.expert_id JOIN outreach_drafts d ON d.id=e.outreach_draft_id WHERE x.source='agent_researched' AND d.status IN ('approved','sent') AND coalesce(d.sent_at,d.created_at)>=date_trunc('day',now() AT TIME ZONE 'UTC')`,[])).rows[0]!;
   if(Number(count.n)>=COLD_CONTACTS_PER_DAY)denied();
  }
  const approved=(await tx.query(`UPDATE outreach_drafts SET status='approved',approved_by=$1 WHERE id=$2 AND status='pending' RETURNING id`,[operatorEmail,id])).rows[0];
  if(!approved)denied();
  await tx.query('UPDATE expert_automation_invitations SET founder_approved_by=$1 WHERE draft_id=$2',[operatorEmail,id]);
  await tx.query("INSERT INTO interventions(operator_email,kind,note) VALUES($1,'approve_outreach',$2)",[operatorEmail,`Approved managed expert contact ${id}; dispatch remains budget/policy gated.`]);
  return true;
 });
}
/** Real pooled SQL for the existing owner route; HTTP query batches are not transactions. */
let ownerPool:Pool|undefined;
export function expertOwnerDatabase():AgentTransactionalSql{
 const pool=ownerPool??=new Pool({connectionString:process.env.DATABASE_URL_UNPOOLED??process.env.DATABASE_URL});
 return {
  query:async<T>(query:string,params?:unknown[])=>({rows:(await pool.query(query,params)).rows as T[]}),
  transaction:async<T>(fn:(tx:AgentSqlExecutor)=>Promise<T>)=>{
   const client=await pool.connect();try{await client.query('BEGIN');const result=await fn({query:async<R>(query:string,params?:unknown[])=>({rows:(await client.query(query,params)).rows as R[]})});await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
 };
}
