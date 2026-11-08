import 'server-only';
import { createHash,randomUUID } from 'node:crypto';
import type { AgentSqlExecutor,AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { IntakeInput,Report,type Finding,type Suite } from '@ae/core/contracts/index';
import type { ServiceContext } from '@ae/core/contracts/services';
import { canonicalJson } from '@ae/core/evals/text/freeze';
import { SuiteRunSchema } from '@ae/core/evals/text/schema';
import { normalizeReferenceText } from '@ae/core/evals/text/schema';
import { projectFrozenTextSuite,projectTextSuiteRun } from '@ae/core/evals/naive-contract-mapping';
import type { TextContractScope } from '@ae/core/evals/naive-contract-mapping';
import { FindingSchema,type JobRef } from '@ae/core/evals/types';
import type { TextInvestigation } from '@ae/core/evals/text/investigate';
import { toContractFinding,TrackBBlockedError } from '@ae/core/evals/service-adapter';
import { inspectDataSafety } from '@ae/core/evals/data/quality';
import { decryptJson } from '@ae/core/storage/crypto';
import { injectCredentials,credentialSlotsOf } from '@/server/intake';
import { createNaiveEngineAdmissionPolicy } from './naive-engine-admission-policy';
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const equal=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const fail=():never=>{throw new TrackBBlockedError('rejected_input','Generic text publication authority or retained evidence changed.');};
import { retainedNaiveExecutionProfile } from './naive-method-authority';
import type { NaiveTextExecutionProfile } from './naive-text-execution-selection';
interface Checkpoint {input_digest:string;state:string;value:any}
interface Owner {customer_id:string;environment:'test'|'live';package:string;state:string;is_mock:boolean;intake:Record<string,unknown>;retest_of_job_id:string|null;credentials_delete_after:Date|string|null;report_blob_path:string|null;suite_blob_path:string|null;delivered_at:Date|string|null;branch_delete_after:Date|string|null}
export interface NaiveTextPublicationDependencies {sql?:AgentTransactionalSql;executionProfile?:NaiveTextExecutionProfile;decryptCredentials?:(ciphertext:string)=>Record<string,string>;clock?:{now():Date}}
export interface NaiveTextPublicationPaths {reportBlobPath:string;suiteBlobPath:string;reportHtmlBlobPath:string;evidenceBlobPath:string}
/** Read-only authority and final SQL publication; never constructs a provider or grants
 * dispatch budget. The pinned transaction locks the canonical job, credentials and
 * retained evidence through the final findings/report/delivery commit. */
export async function createNaiveTextPublication(ctx:ServiceContext,requestedSuite?:Suite,requestedFindings?:Finding[],deps:NaiveTextPublicationDependencies={}){
 const jobId=ctx.jobId,environment=ctx.environment;
 const sql=deps.sql??(await import('@/server/automated-expert-owner')).expertOwnerDatabase();
 const profile=await sql.transaction(tx=>retainedNaiveExecutionProfile(tx,jobId));
 if(deps.executionProfile&&!equal(deps.executionProfile,profile))return fail();
 const SLOT=profile.designId,policy=createNaiveEngineAdmissionPolicy(profile);
 async function read(tx:AgentSqlExecutor,kind:string,id:string,input?:unknown):Promise<Checkpoint>{
  const row=(await tx.query<Checkpoint>(`SELECT input_digest,state,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2 AND id=$3 FOR SHARE`,[jobId,kind,id])).rows[0];
  if(!row||row.state!=='completed'||input!==undefined&&row.input_digest!==hash(input))return fail();return row;
 }
 async function current(tx:AgentSqlExecutor,value?:unknown,allowDelivered=false){
  if(ctx.jobId!==jobId||ctx.environment!==environment)return fail();
  const owner=(await tx.query<Owner>(`SELECT customer_id::text,environment,package,state,is_mock,intake,retest_of_job_id::text,credentials_delete_after,report_blob_path,suite_blob_path,delivered_at,branch_delete_after FROM jobs WHERE id=$1 FOR UPDATE`,[jobId])).rows[0];
  if(!owner||owner.environment!==environment||owner.package!=='text_eval'||owner.is_mock||!['planning','running','investigating',...(allowDelivered?['delivered']:[])].includes(owner.state))return fail();
  if(!equal(await retainedNaiveExecutionProfile(tx,jobId),profile))return fail();
  const binding=await read(tx,'naive_method_binding',SLOT);
  if(binding.input_digest!==hash(binding.value))return fail();
  const job:JobRef={jobId,customerId:owner.customer_id,environment,package:'text_eval',isFixture:false,quoteVersion:null,linkedRetestOf:owner.retest_of_job_id};
  if(!equal(job,binding.value.job)||binding.value.designId!==SLOT||binding.value.versionLabel!==SLOT||binding.value.intakeDigest!==hash(owner.intake))return fail();
  const credential=(await tx.query<{ciphertext:string}>('SELECT ciphertext FROM job_credentials WHERE job_id=$1 FOR SHARE',[jobId])).rows[0];
  const credentials=credential?(deps.decryptCredentials??decryptJson<Record<string,string>>)(credential.ciphertext):{};
  if(Object.values(credentials).some(v=>typeof v!=='string'))return fail();
  // An already committed immutable receipt may be acknowledged after credential
  // cleanup; this cannot dispatch or publish anything new. New publication requires
  // current credentials and exact target binding, even when its report was uploaded.
  const acknowledging=allowDelivered&&owner.state==='delivered';
  if(!acknowledging&&(owner.credentials_delete_after!==null&&new Date(owner.credentials_delete_after).getTime()<=Date.now()||credentialSlotsOf(owner.intake).some(slot=>!credentials[slot])))return fail();
  const intake=IntakeInput.parse(injectCredentials(owner.intake,credentials));
  if(intake.package!=='text_eval'||!intake.authorizedToTest||(owner.intake.endpoint as Record<string,unknown>)?.apiKey)return fail();
  const target={url:intake.endpoint.url,model:intake.endpoint.model,...(intake.endpoint.apiKey?{apiKey:intake.endpoint.apiKey}:{}),systemPrompt:intake.endpoint.systemPrompt};
  if((!acknowledging||credential)&&binding.value.targetVersion!==hash(target))return fail();
  const secrets=[...Object.values(credentials),...Object.entries(process.env).filter(([k])=>/(?:KEY|TOKEN|SECRET|DATABASE_URL)$/.test(k)).map(([,v])=>v??'')].filter(v=>v.length>=4);
  if(!inspectDataSafety({intake:owner.intake,value},secrets).safe)return fail();
  const identity={jobId,customerId:owner.customer_id,environment,designId:SLOT,versionLabel:SLOT,inputDigest:hash({package:intake.package,authorizedToTest:intake.authorizedToTest,endpoint:{url:intake.endpoint.url,model:intake.endpoint.model,systemPrompt:intake.endpoint.systemPrompt,referenceText:normalizeReferenceText(intake.endpoint.referenceText??null)},notes:intake.notes??null})};
  const admission=await read(tx,'naive_admission',SLOT,identity);
  if(admission.value.status!=='approved'||!equal(admission.value.identity,identity))return fail();
  const {scope,frozen}=admission.value.artifact as {scope:TextContractScope;frozen:unknown};
  if(scope.jobId!==jobId||scope.customerId!==owner.customer_id||scope.environment!==environment)return fail();
  await policy.authorizeApproval(tx,scope.approvalArtifactId,identity);
  const projection=projectFrozenTextSuite(frozen,scope,secrets);
  const approved=await read(tx,'naive_approved_suite',scope.approvalArtifactId,scope);
  if(!equal(approved.value,projection.retained)||requestedSuite&&!equal(requestedSuite,projection.suite))return fail();
  const runId=`generic-${hash({scope,targetVersion:binding.value.targetVersion}).slice(0,24)}`;
  const artifactBinding={scope,runId,targetVersion:binding.value.targetVersion};
  const retained=await read(tx,'naive_run_artifact',runId,artifactBinding);
  if(retained.value.schemaVersion!=='naive_contract_run.v1'||!equal(retained.value.scope,scope))return fail();
  const run=SuiteRunSchema.parse(retained.value.run);
  const runInput={suiteDigest:scope.suiteDigest,targetVersion:binding.value.targetVersion,ids:projection.retained.frozen.scenarios.map(s=>s.id),attempt:'initial',baselineRunId:null};
  const richRun=await read(tx,'run_result',runId,{environment,input:runInput});
  const richIdentity=await read(tx,'run_identity',runId,{environment,input:runInput});
  if(!equal(richRun.value,{environment,run})||richIdentity.value.targetVersion!==binding.value.targetVersion||richIdentity.value.startedAt!==run.startedAt)return fail();
  const publicRun=projectTextSuiteRun(run,projection,scope,secrets).result;
  const investigation=await read(tx,'naive_investigation_artifact',runId,artifactBinding);
  if(!equal(investigation.value.scope,scope)||investigation.value.runId!==runId||investigation.value.targetVersion!==binding.value.targetVersion)return fail();
  const rich=investigation.value.investigation as TextInvestigation;
  const engineInvestigation=await read(tx,'investigation',runId,{environment,input:{suiteDigest:scope.suiteDigest,run,targetVersion:binding.value.targetVersion}});
  if(!equal(engineInvestigation.value,rich)||!['completed','skipped'].includes(rich.investigatorStatus)||!Array.isArray(rich.limitations)||rich.limitations.some(v=>typeof v!=='string'))return fail();
  const findings=rich.findings.map(f=>toContractFinding(FindingSchema.parse(f)));
  if(requestedFindings&&!equal(requestedFindings,findings))return fail();
  if(!inspectDataSafety({projection,run,rich,findings},secrets).safe)return fail();
  const assessed=publicRun.results.filter(r=>r.assessment?.kind==='objective'||r.assessment?.kind==='rubric').length;
  const summary=`Text baseline assessment: ${assessed} of ${publicRun.results.length} scenarios assessed.\n${publicRun.results.map(r=>`${r.scenarioId}: ${r.assessment?.kind??'objective'}; ${r.assessment?.checks.map(c=>`${c.checkId}=${c.status}${c.reason?` (${c.reason})`:''}`).join('; ')??''}`).join('\n')}\nLimitations: ${rich.limitations.join('; ')||'No additional investigator limitations.'}\nRemediation and rerun verification were not performed. Full target responses, check evidence, and reproductions are retained privately.`;
  const proof={binding,admission,approved,retained,richRun,richIdentity,investigation,engineInvestigation};
  return {owner,identity,scope,findings,suite:projection.suite,assessed,summary,proof,secrets};
 }
 const initial=await sql.transaction(tx=>current(tx,undefined,true)),fixed=hash(initial.proof);
 async function checked(tx:AgentSqlExecutor,value?:unknown,allowDelivered=false){const a=await current(tx,value,allowDelivered);if(hash(a.proof)!==fixed)return fail();return a;}
 return {
  assertCurrent:async(value?:unknown)=>{await sql.transaction(tx=>checked(tx,value,true));},
  reportContext:async()=>{const a=await sql.transaction(tx=>checked(tx,undefined,true));return {assessed:a.assessed,summary:a.summary};},
  atomicPublish:async(raw:Report,paths:NaiveTextPublicationPaths):Promise<{deliveredAtIso:string}>=>sql.transaction(async tx=>{
   const report=Report.parse(raw);
   if(!equal(raw,report)||report.jobId!==jobId||!equal(report.findings,initial.findings)||Object.keys(paths).sort().join(',')!=='evidenceBlobPath,reportBlobPath,reportHtmlBlobPath,suiteBlobPath'||Object.values(paths).some(v=>typeof v!=='string'||!v||v.length>4096||v.includes('\0')))return fail();
   const a=await checked(tx,{report,paths},true);
   if(!a.assessed)throw new TrackBBlockedError('needs_operator','Generic text report has no assessed scenarios; hold publication.');
   const input={identity:a.identity,evidenceDigest:fixed,report,paths};
   const prior=(await tx.query<Checkpoint>(`SELECT input_digest,state,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_text_publication' AND id=$2 FOR UPDATE`,[jobId,SLOT])).rows[0];
   const baselineFindings=(await tx.query<{finding_key:string;data:unknown}>(`SELECT finding_key,data FROM findings WHERE job_id=$1 AND rerun_of_finding_id IS NULL FOR UPDATE`,[jobId])).rows;
   if(baselineFindings.some(row=>!a.findings.some(f=>f.id===row.finding_key&&equal(f,row.data))))return fail();
   if(prior){
    if(baselineFindings.length!==a.findings.length)return fail();
    if(prior.state!=='completed'||prior.input_digest!==hash(input)||!equal(prior.value.input,input)||prior.value.receiptDigest!==hash({input,deliveredAtIso:prior.value.deliveredAtIso,credentialsDeleteAfter:prior.value.credentialsDeleteAfter,branchDeleteAfter:prior.value.branchDeleteAfter})||a.owner.state!=='delivered'||a.owner.report_blob_path!==paths.reportBlobPath||a.owner.suite_blob_path!==paths.suiteBlobPath||new Date(a.owner.delivered_at!).toISOString()!==prior.value.deliveredAtIso||new Date(a.owner.credentials_delete_after!).toISOString()!==prior.value.credentialsDeleteAfter||new Date(a.owner.branch_delete_after!).toISOString()!==prior.value.branchDeleteAfter)return fail();
    return {deliveredAtIso:prior.value.deliveredAtIso};
   }
   if(a.owner.state==='delivered')return fail();
   for(const finding of a.findings){
    const rows=(await tx.query<{data:unknown}>(`SELECT data FROM findings WHERE job_id=$1 AND finding_key=$2 AND rerun_of_finding_id IS NULL FOR UPDATE`,[jobId,finding.id])).rows;
    if(rows.length>1||rows.some(row=>!equal(row.data,finding)))return fail();
    if(!rows.length)await tx.query(`INSERT INTO findings(job_id,finding_key,data) VALUES($1,$2,$3::jsonb)`,[jobId,finding.id,JSON.stringify(finding)]);
   }
   const deliveredAt=(deps.clock?.now()??new Date()).toISOString(),credentialsDeleteAfter=new Date(new Date(deliveredAt).getTime()+24*3600000).toISOString(),branchDeleteAfter=new Date(new Date(deliveredAt).getTime()+48*3600000).toISOString();
   const receipt={input,deliveredAtIso:deliveredAt,credentialsDeleteAfter,branchDeleteAfter,receiptDigest:hash({input,deliveredAtIso:deliveredAt,credentialsDeleteAfter,branchDeleteAfter})};
   await tx.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_text_publication',$2,$3,$4,'completed',$5::jsonb)`,[jobId,SLOT,hash(input),randomUUID(),JSON.stringify(receipt)]);
   await tx.query(`UPDATE jobs SET state='delivered',report_blob_path=$2,suite_blob_path=$3,delivered_at=$4,credentials_delete_after=$5,branch_delete_after=$6,updated_at=$4 WHERE id=$1`,[jobId,paths.reportBlobPath,paths.suiteBlobPath,deliveredAt,credentialsDeleteAfter,branchDeleteAfter]);
   await tx.query(`INSERT INTO progress_events(job_id,milestone,message) VALUES($1,'report_stored','Report and evidence stored.'),($1,'delivered','Your report is ready.')`,[jobId]);
   await checked(tx,{report,paths},true);
   return {deliveredAtIso:deliveredAt};
  }),
 };
}

/** Acknowledges an already committed delivery after a lost transaction response.
 * It cannot publish, dispatch or reinstate revoked authority. Current owner/environment,
 * receipt digest and attached SQL paths/deadlines must still match exactly. */
async function committedDelivery(tx:AgentSqlExecutor,ctx:Pick<ServiceContext,'jobId'|'environment'>):Promise<{deliveredAtIso:string;receiptDigest:string}|null>{
  const owner=(await tx.query<Owner>(`SELECT customer_id::text,environment,package,is_mock,state,report_blob_path,suite_blob_path,delivered_at,credentials_delete_after,branch_delete_after FROM jobs WHERE id=$1 FOR SHARE`,[ctx.jobId])).rows[0];
  const profile=await retainedNaiveExecutionProfile(tx,ctx.jobId),SLOT=profile.designId;
  const row=(await tx.query<Checkpoint>(`SELECT input_digest,state,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_text_publication' AND id=$2 FOR SHARE`,[ctx.jobId,SLOT])).rows[0];
  if(!row)return null;
  const v=row.value,input=v?.input;
  if(row.state!=='completed'||!owner||owner.package!=='text_eval'||owner.is_mock||owner.state!=='delivered'||owner.environment!==ctx.environment||input?.identity?.jobId!==ctx.jobId||input.identity.environment!==ctx.environment||input.identity.customerId!==owner.customer_id||input.identity.designId!==profile.designId||input.identity.versionLabel!==profile.versionLabel||row.input_digest!==hash(input)||v.receiptDigest!==hash({input,deliveredAtIso:v.deliveredAtIso,credentialsDeleteAfter:v.credentialsDeleteAfter,branchDeleteAfter:v.branchDeleteAfter})||owner.report_blob_path!==input.paths.reportBlobPath||owner.suite_blob_path!==input.paths.suiteBlobPath||new Date(owner.delivered_at!).toISOString()!==v.deliveredAtIso||new Date(owner.credentials_delete_after!).toISOString()!==v.credentialsDeleteAfter||new Date(owner.branch_delete_after!).toISOString()!==v.branchDeleteAfter)return fail();
  const findings=(await tx.query<{finding_key:string;data:unknown}>(`SELECT finding_key,data FROM findings WHERE job_id=$1 AND rerun_of_finding_id IS NULL FOR SHARE`,[ctx.jobId])).rows;
  if(!Array.isArray(input.report?.findings)||findings.length!==input.report.findings.length||findings.some(row=>!input.report.findings.some((f:Finding)=>f.id===row.finding_key&&equal(f,row.data))))return fail();
  return {deliveredAtIso:v.deliveredAtIso,receiptDigest:v.receiptDigest as string};
}
export async function readNaiveTextDeliveryReceipt(ctx:Pick<ServiceContext,'jobId'|'environment'>,deps:NaiveTextPublicationDependencies={}):Promise<{deliveredAtIso:string}|null>{
 const sql=deps.sql??(await import('@/server/automated-expert-owner')).expertOwnerDatabase();
 return sql.transaction(async tx=>{const receipt=await committedDelivery(tx,ctx);return receipt?{deliveredAtIso:receipt.deliveredAtIso}:null;});
}
export type NaiveTextNotificationClaim={status:'claimed';token:string}|{status:'completed'}|{status:'pending'};
/** A send intent never expires or resets automatically. A lost acknowledgement requires
 * explicit reconciliation; retry cannot create a second customer notification. */
export async function claimNaiveTextDeliveryNotification(ctx:Pick<ServiceContext,'jobId'|'environment'>,deps:NaiveTextPublicationDependencies={}):Promise<NaiveTextNotificationClaim>{
 const sql=deps.sql??(await import('@/server/automated-expert-owner')).expertOwnerDatabase();
 return sql.transaction(async tx=>{
  const receipt=await committedDelivery(tx,ctx);if(!receipt)return fail();
  const SLOT=(await retainedNaiveExecutionProfile(tx,ctx.jobId)).designId;
  const digest=hash({jobId:ctx.jobId,environment:ctx.environment,receiptDigest:receipt.receiptDigest}),token=randomUUID();
  const inserted=await tx.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_text_notification',$2,$3,$4,'pending',NULL) ON CONFLICT DO NOTHING RETURNING token`,[ctx.jobId,SLOT,digest,token]);
  const row=(await tx.query<Checkpoint&{token:string}>(`SELECT input_digest,state,value,token FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_text_notification' AND id=$2 FOR UPDATE`,[ctx.jobId,SLOT])).rows[0];
  if(!row||row.input_digest!==digest||!['pending','completed'].includes(row.state)||row.state==='completed'&&!equal(row.value,receipt))return fail();
  if(inserted.rows.length)return {status:'claimed',token};
  return {status:row.state==='completed'?'completed':'pending'};
 });
}
export async function completeNaiveTextDeliveryNotification(ctx:Pick<ServiceContext,'jobId'|'environment'>,token:string,deps:NaiveTextPublicationDependencies={}):Promise<void>{
 const sql=deps.sql??(await import('@/server/automated-expert-owner')).expertOwnerDatabase();
 return sql.transaction(async tx=>{
  const receipt=await committedDelivery(tx,ctx);if(!receipt||!token)return fail();
  const SLOT=(await retainedNaiveExecutionProfile(tx,ctx.jobId)).designId;
  const digest=hash({jobId:ctx.jobId,environment:ctx.environment,receiptDigest:receipt.receiptDigest});
  const row=(await tx.query<Checkpoint&{token:string}>(`SELECT input_digest,state,value,token FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_text_notification' AND id=$2 FOR UPDATE`,[ctx.jobId,SLOT])).rows[0];
  if(!row||row.input_digest!==digest||row.token!==token||!['pending','completed'].includes(row.state)||row.state==='completed'&&!equal(row.value,receipt))return fail();
  if(row.state==='pending')await tx.query(`UPDATE text_integration.checkpoints SET state='completed',value=$3::jsonb WHERE job_id=$1 AND kind='naive_text_notification' AND id=$2`,[ctx.jobId,SLOT,JSON.stringify(receipt)]);
 });
}
