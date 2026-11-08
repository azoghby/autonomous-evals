import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { IntakeInput as IntakeSchema } from '@ae/core/contracts/index';
import type { ServiceContext } from '@ae/core/contracts/services';
import type { JobRef } from '@ae/core/evals/types';
import { createNaiveArtifactStore, type NaiveArtifactStoreDeps } from '@ae/core/evals/naive-artifact-store';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import { canonicalJson } from '@ae/core/evals/text/freeze';
import { projectFrozenTextSuite, restoreFrozenTextSuite } from '@ae/core/evals/naive-contract-mapping';
import type { Suite } from '@ae/core/contracts/index';
import { normalizeReferenceText } from '@ae/core/evals/text/schema';
import type { NaiveTextDesignIdentity } from '@ae/core/evals/naive-design-service';
import { TrackBBlockedError, TrackBPendingError } from '@ae/core/evals/service-adapter';
import { inspectDataSafety } from '@ae/core/evals/data/quality';
import { decryptJson } from '@ae/core/storage/crypto';
import { credentialSlotsOf, injectCredentials } from '@/server/intake';

import type { NaiveTextExecutionProfile } from './naive-text-execution-selection';
export const LEGACY_EXECUTION_PROFILE:NaiveTextExecutionProfile={policyId:'generic-text-v1',designId:'generic-text-v1',versionLabel:'generic-text-v1',admissionPolicyId:'automated-text-design-v1'};
/** Read selected identity under the canonical job lock; no feature flags or evaluator permission. */
export async function retainedNaiveExecutionProfile(tx:Tx,jobId:string):Promise<NaiveTextExecutionProfile>{
 const owner=(await tx.query<{customer_id:string;environment:string}>('SELECT customer_id::text,environment FROM jobs WHERE id=$1 FOR UPDATE',[jobId])).rows[0];
 if(!owner)return fail();
 const rows=(await tx.query<{state:string;input_digest:string;value:any}>(`SELECT state,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_execution_policy' AND id='selection-v1' FOR SHARE`,[jobId])).rows;
 let profile:NaiveTextExecutionProfile={...LEGACY_EXECUTION_PROFILE};
 if(rows.length){
 const r=rows[0],v=r.value,p=v?.profile;
 if(r.state!=='completed'||r.input_digest!==hash(v)||v?.schemaVersion!=='naive_text_execution_selection.v1'||v.identity?.jobId!==jobId||v.identity.customerId!==owner.customer_id||v.identity.environment!==owner.environment||!p)return fail();
 const expected=p.policyId==='generic-text-v1'?LEGACY_EXECUTION_PROFILE:{policyId:'generic-text-factual-gap-v1',designId:'generic-text-factual-gap-v1',versionLabel:'generic-text-factual-gap-v1',admissionPolicyId:'automated-text-design-factual-gap-v1',factualGapPolicy:'propose_missing_reference.v1',expertTaskId:p.expertTaskId};
 if(canonicalJson(v)!==canonicalJson({schemaVersion:'naive_text_execution_selection.v1',identity:{jobId,customerId:owner.customer_id,environment:owner.environment},profile:expected})||p.policyId!=='generic-text-v1'&&!(typeof p.expertTaskId==='string'&&/^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/.test(p.expertTaskId)))return fail();
 profile=p;
 }
 const bindings=(await tx.query<{id:string;state:string;input_digest:string;value:any}>(`SELECT id,state,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_method_binding' FOR SHARE`,[jobId])).rows;
 if(bindings.length>1||bindings.some(r=>r.id!==profile.designId||r.state!=='completed'||r.input_digest!==hash(r.value)||r.value?.designId!==profile.designId||r.value?.versionLabel!==profile.versionLabel||r.value?.job?.jobId!==jobId||r.value?.job?.customerId!==owner.customer_id||r.value?.job?.environment!==owner.environment))return fail();
 return profile;
}
type Tx = Parameters<Parameters<AgentTransactionalSql['transaction']>[0]>[0];
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail=():never=>{throw new TrackBBlockedError('rejected_input','Canonical generic text authority changed or unavailable.');};
export interface NaiveMethodAuthorityDeps {
 sql: AgentTransactionalSql;
 executionProfile?:NaiveTextExecutionProfile;
 /** Trusted independent review authority. Must check current exact receipt/revocation on every call.
  * Human approval may only be asserted by an authenticated retained human receipt.
  * A code admission policy may approve independently reviewed engine output under its own policy ID. */
 admissionPolicy: NaiveArtifactStoreDeps['decide'];
 /** Recheck current approval authority, including after retained replay. */
 authorizeApproval(tx:Tx,approvalArtifactId:string,identity:NaiveTextDesignIdentity):Promise<void>;
 decryptCredentials?:(ciphertext:string)=>Record<string,string>;
}
interface OwnerRow { customer_id:string; environment:'test'|'live'; intake:Record<string,unknown>; retest_of_job_id:string|null }
/** Internal paid Workflow capability. No caller/model-provided owner, slot or version is accepted. */
export async function createNaiveMethodAuthority(ctx:ServiceContext,deps:NaiveMethodAuthorityDeps) {
 const captured={jobId:ctx.jobId,environment:ctx.environment};
 const profile=structuredClone(deps.executionProfile??LEGACY_EXECUTION_PROFILE);
 const {designId,versionLabel}=profile;
 async function basic(tx:Tx) {
  if(profile.policyId==='generic-text-factual-gap-v1'&&(process.env.EVAL_SERVICES!=='real'||process.env.EVAL_NAIVE_FACTUAL_GAPS!=='1'))throw new TrackBBlockedError('needs_operator','Selected factual execution is on hold.');
  if(ctx.jobId!==captured.jobId||ctx.environment!==captured.environment||!Number.isSafeInteger(ctx.budgetMicroUsd)||ctx.budgetMicroUsd<=0) return fail();
  const selected=await retainedNaiveExecutionProfile(tx,ctx.jobId);
  if(canonicalJson(selected)!==canonicalJson(profile))return fail();
  const row=(await tx.query<OwnerRow>(`SELECT customer_id::text,environment,intake,retest_of_job_id::text FROM jobs
   WHERE id=$1 AND environment=$2 AND package='text_eval' AND NOT is_mock
   AND state IN ('planning','running','investigating')
   AND (credentials_delete_after IS NULL OR credentials_delete_after>now()) FOR SHARE`,[ctx.jobId,ctx.environment])).rows[0];
  if(!row||!row.customer_id||row.environment!==ctx.environment)return fail();
  const stored=(await tx.query<{ciphertext:string}>('SELECT ciphertext FROM job_credentials WHERE job_id=$1 FOR SHARE',[ctx.jobId])).rows[0];
  const credentials=stored?(deps.decryptCredentials??decryptJson<Record<string,string>>)(stored.ciphertext):{};
  if(!credentials||Object.values(credentials).some(v=>typeof v!=='string')||credentialSlotsOf(row.intake).some(slot=>!credentials[slot]))return fail();
  const intake=IntakeSchema.parse(injectCredentials(row.intake,credentials));
  if(intake.package!=='text_eval'||!intake.authorizedToTest||!!(row.intake.endpoint as Record<string,unknown>)?.apiKey)return fail();
  const secrets=[...Object.values(credentials),...Object.entries(process.env).filter(([k])=>/(?:KEY|TOKEN|SECRET|DATABASE_URL)$/.test(k)).map(([,v])=>v??'')].filter(v=>v.length>=4);
  if(!inspectDataSafety(row.intake,secrets).safe)return fail();
  const target={url:intake.endpoint.url,model:intake.endpoint.model,...(intake.endpoint.apiKey?{apiKey:intake.endpoint.apiKey}:{}),systemPrompt:intake.endpoint.systemPrompt};
  const job:JobRef={jobId:ctx.jobId,customerId:row.customer_id,environment:row.environment,package:'text_eval',isFixture:false,quoteVersion:null,linkedRetestOf:row.retest_of_job_id};
  // Hash secrets with all other target configuration, never persist them in the binding.
  const binding={job,designId,versionLabel,intakeDigest:hash(row.intake),targetVersion:hash(target)};
  return {job,intake,target,secrets,knownSecrets:secrets,designId,versionLabel,binding,targetVersion:binding.targetVersion};
 }
 const first=await deps.sql.transaction(tx=>basic(tx));const fixed=hash(first.binding);
 async function current(tx:Tx,value?:unknown) {
  const a=await basic(tx);
  if(hash(a.binding)!==fixed||value!==undefined&&!inspectDataSafety(value,a.secrets).safe)return fail();
  const saved=(await tx.query<{input_digest:string;state:string;value:unknown}>(`SELECT input_digest,state,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_method_binding' AND id=$2 FOR SHARE`,[ctx.jobId,designId])).rows[0];
  if(!saved||saved.input_digest!==fixed||saved.state!=='completed'||canonicalJson(saved.value)!==canonicalJson(a.binding))return fail();
  const approval=(await tx.query<{value:{status:string;artifact?:{scope:{approvalArtifactId:string}}}}>(`SELECT value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_admission' AND id=$2 AND state='completed'`,[ctx.jobId,designId])).rows[0]?.value;
  if(approval?.status==='approved'){if(!approval.artifact)return fail();await deps.authorizeApproval(tx,approval.artifact.scope.approvalArtifactId,identityOf(a));}
  return a;
 }
 function identityOf(a:Awaited<ReturnType<typeof basic>>):NaiveTextDesignIdentity {
  const input=a.intake;
  return {jobId:a.job.jobId,customerId:a.job.customerId,environment:a.job.environment,designId,versionLabel,inputDigest:hash({package:input.package,authorizedToTest:input.authorizedToTest,endpoint:{url:input.endpoint.url,model:input.endpoint.model,systemPrompt:input.endpoint.systemPrompt,referenceText:normalizeReferenceText(input.endpoint.referenceText??null)},notes:input.notes??null})};
 }
 await deps.sql.transaction(async tx=>{
  const a=await basic(tx);if(hash(a.binding)!==fixed)return fail();
  await tx.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_method_binding',$2,$3,$4,'completed',$5::jsonb) ON CONFLICT DO NOTHING`,[ctx.jobId,designId,fixed,randomUUID(),JSON.stringify(a.binding)]);
  await current(tx);
 });
 const artifacts=createNaiveArtifactStore({sql:deps.sql,authorize:async(tx,scope)=>{
  const a=await current(tx);
  if(scope.jobId!==a.job.jobId||scope.customerId!==a.job.customerId||scope.environment!==a.job.environment||scope.designId!==undefined&&scope.designId!==designId)return fail();
  if(scope.approvalArtifactId){const identity=await designIdentity(tx);await deps.authorizeApproval(tx,scope.approvalArtifactId,identity);}
  return {knownSecrets:a.secrets};
 },decide:async(tx,identity,suite)=>{
  if(canonicalJson(identity)!==canonicalJson(await designIdentity(tx)))return fail();
  const a=await current(tx,suite);
  if(suite.systemPrompt!==a.intake.endpoint.systemPrompt||suite.versionLabel!==versionLabel||suite.referenceText!==normalizeReferenceText(a.intake.endpoint.referenceText??null))return fail();
  return deps.admissionPolicy(tx,identity,suite);
 }});
 async function designIdentity(tx:Tx):Promise<NaiveTextDesignIdentity>{
  return identityOf(await current(tx));
 }
 return {artifacts,checkpoints:new PostgresTextCheckpointStore(deps.sql),
  authorizeDesign:async(request:ServiceContext)=>{if(request.jobId!==captured.jobId||request.environment!==captured.environment)return fail();return deps.sql.transaction(tx=>current(tx));},
  currentInTransaction:current,
  current:(value?:unknown)=>deps.sql.transaction(tx=>current(tx,value)),designIdentity:(tx?:Tx)=>tx?designIdentity(tx):deps.sql.transaction(tx=>designIdentity(tx)),
  resolveSuite:async(publicSuite?:Suite)=>{
   const a=await deps.sql.transaction(tx=>current(tx)),identity=await deps.sql.transaction(tx=>designIdentity(tx));
   const admission=await artifacts.admission.load(identity);
   if(!admission||admission.status==='pending')throw new TrackBPendingError(5_000,'Generic text design admission pending.');
   if(admission.status!=='approved')return fail();
   const {scope,frozen}=admission.artifact,projection=projectFrozenTextSuite(frozen,scope,a.secrets);
   if(publicSuite)restoreFrozenTextSuite(publicSuite,admission.artifact,scope,a.secrets);
   await deps.sql.transaction(tx=>current(tx,projection));
   return {...a,scope,frozen,retained:projection.retained,suite:projection.suite,runId:`generic-${hash({scope,targetVersion:a.targetVersion}).slice(0,24)}`};
  }};
}
