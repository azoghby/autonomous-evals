import { createWorkflowStageBudgetLedger } from './workflow-stage-budget';
import { assertFactualGapPlanCurrent } from './expert-data-plan-binding';
import 'server-only';
import { createHash } from 'node:crypto';
import { createClient } from '@usenaive-sdk/managed-agents';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import type { AgentTaskRunner } from '@ae/core/agents/session-service';
import { currentWorkflowStageScope, assertWorkflowStageCurrent } from './workflow-stage-runtime';
import { assertWorkflowStageOwner } from '@ae/core/db/workflow-stage-authority';
import { fenceWorkflowStageSessions, fenceWorkflowStageRunner } from './workflow-stage-children';
import { buildAgentDeps } from '@ae/core/integration/eval-services';
import type { ServiceContext, RunResult } from '@ae/core/contracts/services';
import { JOB_BUDGET_MICRO_USD } from '@ae/core/contracts/index';
import { CostEntrySchema, type JobRef } from '@ae/core/evals/types';
import { toContractCost } from '@ae/core/evals/service-adapter';
import { createNaiveRunService } from '@ae/core/evals/naive-run-service';
import { createNaiveInvestigationService } from '@ae/core/evals/naive-investigation-service';
import { createNaiveArtifactStore } from '@ae/core/evals/naive-artifact-store';
import { projectFrozenTextSuite, type TextContractScope } from '@ae/core/evals/naive-contract-mapping';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import { verifyAdmittedFrozenSuite, canonicalJson } from '@ae/core/evals/text/freeze';
import { frozenDataReference } from '@ae/core/evals/data/adapters/mapping';
import { createPostgresEvaluationDataStore } from '@ae/core/evals/data/postgres-store';
import { createPostgresDataOperationLedger } from '@ae/core/evals/data/postgres-operations';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { dataReviewRequestDigest, type AuthenticatedDataReview, type DataOrchestrationResult } from '@ae/core/evals/data/orchestration';
import type { DataBatch } from '@ae/core/evals/data/acquisition';
import { inspectDataSafety } from '@ae/core/evals/data/quality';
import { createTextTarget } from '@ae/core/targets/text';
import type { JsonTransport } from '@ae/core/targets/transport';
import { createAttemptAwareJudge, drainRuntimeJudgeAccounting } from './judge-attempt-runtime';
import { createNaiveProxyBudget } from '@ae/core/judges/naive-proxy-budget';
import { COMPANY_ROLE_DEFINITIONS } from '@ae/core/agents/company-roles';
import { decryptJson } from '@ae/core/storage/crypto';
import { isOperator } from '@ae/core/auth/tokens';
import { expertOwnerDatabase } from './automated-expert-owner';
import { credentialSlotsOf, injectCredentials } from './intake';
import type { ProductionDataInput } from './expert-data-production';

/** Month-wide `agent:judge:<period>` scope cap: the judge role's monthly cap, identical for every writer (never a per-job cap). */
const JUDGE_MONTHLY_CAP_MICRO_USD = COMPANY_ROLE_DEFINITIONS.judge.monthlyMicroUsd;
const fail = (): never => { throw new Error('expert_text_authority_unavailable'); };
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
type Tx = Parameters<Parameters<AgentTransactionalSql['transaction']>[0]>[0];
/** A supplied tx is the artifact/binding writer's pinned transaction. Plain runtime
 * checks use their own short transaction and do not claim atomic publication. */
export async function assertExpertTextStage(jobId:string,tx?:Tx):Promise<void>{
 const scope=currentWorkflowStageScope();if(!scope)return;
 scope.assertActive?.();
 if(scope.owner.jobId!==jobId)return fail();
 if(tx)await assertWorkflowStageOwner(tx,scope.owner);
 else await assertWorkflowStageCurrent();
}
interface OwnerRow { customer_id: string; environment: 'test'|'live'; intake: Record<string,unknown>; retest_of_job_id: string|null;
 input: ProductionDataInput; input_digest: string; last_result: DataOrchestrationResult }
export interface ExpertTextRuntimeDependencies {
 sql?: AgentTransactionalSql;
 runner?: AgentTaskRunner;
 /** Tests replace provider transports only; all owner SQL/checkpoints/admission remain real. */
 targetTransport?: JsonTransport;
 proxyFetch?: typeof fetch;
}

/** Server-only capability invoked by the existing paid job Workflow. Never expose as a route/action. */
export async function createExpertTextRuntime(ctx: ServiceContext, deps: ExpertTextRuntimeDependencies = {}) {
 const sql = deps.sql ?? expertOwnerDatabase();
 await drainRuntimeJudgeAccounting(ctx.jobId,sql,deps.proxyFetch);
 const cap = JOB_BUDGET_MICRO_USD.text_eval;
 const checkpoints=new PostgresTextCheckpointStore(sql);
 // Measured session costs are retained before any post-dispatch publication permission check.
 // Cost replay is separate from target/publication authority; the adopted sink binds job owner/environment.
 async function deliverSessionCost(cost:unknown,deliver=true) {
  const parsed=CostEntrySchema.parse(cost);
  if(parsed.jobId!==ctx.jobId||!parsed.measured||!parsed.externalId) return fail();
  const k={jobId:ctx.jobId,kind:'expert_runtime_cost',id:hash(parsed.externalId),inputDigest:hash(parsed)};
  const claim=await checkpoints.claim(k);
  if(claim.state==='claimed')await checkpoints.complete(k,claim.token,parsed);
  else if(claim.state!=='completed'||canonicalJson(claim.value)!==canonicalJson(parsed))return fail();
  if(deliver)await ctx.recordCost(toContractCost(parsed));
 }
 const receipts=await sql.query<{value:unknown}>("SELECT value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='expert_runtime_cost' AND state='completed' ORDER BY id LIMIT 1001",[ctx.jobId]);
 if(receipts.rows.length>1000)return fail();
 for(const receipt of receipts.rows)await deliverSessionCost(receipt.value);
 async function basic(tx: Tx = sql) {
  await assertFactualGapPlanCurrent(tx,ctx.jobId);
  if (process.env.EVAL_SERVICES !== 'real') return fail();
  const row = (await tx.query<OwnerRow>(`SELECT j.customer_id::text,j.environment,j.intake,j.retest_of_job_id::text,p.input,p.input_digest,p.last_result
   FROM jobs j JOIN expert_workflow.plans p ON p.job_id=j.id
   WHERE j.id=$1 AND j.environment=$2 AND j.customer_id=p.tenant_id AND j.package='text_eval' AND NOT j.is_mock
   AND j.state IN ('planning','running','investigating') AND p.enabled AND p.response_deadline>now()`,[ctx.jobId,ctx.environment])).rows[0];
  if (!row || row.input.task.jobId !== ctx.jobId || reviewDigest(row.input)!==row.input_digest) return fail();
  const stored = (await tx.query<{ciphertext:string}>('SELECT ciphertext FROM job_credentials WHERE job_id=$1',[ctx.jobId])).rows[0];
  const credentials = stored ? decryptJson<Record<string,string>>(stored.ciphertext) : {};
  if (!credentials || Object.values(credentials).some(v=>typeof v!=='string') || credentialSlotsOf(row.intake).some(slot=>!credentials[slot])) return fail();
  const endpoint = injectCredentials(row.intake,credentials).endpoint as {url:string;model:string;apiKey?:string;systemPrompt?:string}|undefined;
  if (!endpoint || typeof endpoint.url!=='string' || typeof endpoint.model!=='string') return fail();
  const target = {url:endpoint.url,model:endpoint.model,...(endpoint.apiKey ? {apiKey:endpoint.apiKey}:{}),systemPrompt:endpoint.systemPrompt ?? ''};
  const secrets = [...Object.values(credentials),...Object.entries(process.env).filter(([k])=>/(?:KEY|TOKEN|SECRET|DATABASE_URL)$/.test(k)).map(([,v])=>v??'')].filter(v=>v.length>=4);
  if (!inspectDataSafety({input:row.input,last_result:row.last_result},secrets).safe) return fail();
  const job: JobRef = {jobId:ctx.jobId,customerId:row.customer_id,environment:row.environment,package:'text_eval',isFixture:false,quoteVersion:null,linkedRetestOf:row.retest_of_job_id};
  return {row,target,secrets,job};
 }
 async function authorized(tx: Tx = sql) {
  const a = await basic(tx);
  const transactional: AgentTransactionalSql = {query:tx.query.bind(tx),transaction: fn=>fn(tx)};
  const operations = createPostgresDataOperationLedger(transactional,{tenantId:a.job.customerId,jobId:ctx.jobId,ownerId:'data_service_v1',knownSecrets:a.secrets,
   authenticateOwner:async()=>{await basic(tx);return {ownerId:'data_service_v1'};}});
  const task = await createPostgresEvaluationDataStore(transactional,{tenantId:a.job.customerId,jobId:ctx.jobId,knownSecrets:a.secrets}).get(a.row.input.task.taskId);
  if (!task || canonicalJson(task.spec)!==canonicalJson(a.row.input.task)) return fail();
  const initial={sources:a.row.input.initial.sources.map(s=>({...s,review:{status:'pending',reviewerId:'',reviewedAt:'',notes:''}})),
   cases:a.row.input.initial.cases.map(c=>{const {verification:_verification,...candidate}=c;return candidate;})};
  if(task.requestHash!==createHash('sha256').update(JSON.stringify({spec:a.row.input.task,initial})).digest('hex'))return fail();
  const prefix = `evaluation-data:${task.taskId}:${task.requestHash}`;
  const freeze = await operations.get(`${prefix}:freeze`);
  if (freeze?.state!=='complete') return fail();
  const frozen = verifyAdmittedFrozenSuite(freeze.result);
  if((a.row.input.context.systemPrompt??'')!==a.target.systemPrompt)return fail();
  const context = {...a.row.input.context,job:a.job};
  const reference = frozenDataReference(task,frozen,{...context,knownSecrets:a.secrets});
  if (freeze.digest!==reviewDigest({context,provenance:reference.provenance}) || a.row.last_result?.status!=='ready'
   || canonicalJson(a.row.last_result.frozen)!==canonicalJson({suite:frozen,provenance:reference.provenance})
   || canonicalJson(a.row.last_result.task)!==canonicalJson(task)) return fail();
  // A ready flag or a digest alone grants no human authority. Bind exact reviewed records to retained receipts.
  const reviews = await tx.query<{operation_key:string}>(`SELECT operation_key FROM evaluation_data_persistence.operations
   WHERE tenant_id=$1 AND job_id=$2 AND operation_key LIKE $3 ORDER BY operation_key LIMIT 101`,[a.job.customerId,ctx.jobId,`${prefix}:review:%`]);
  if (!reviews.rows.length || reviews.rows.length>100) return fail();
  const approved: AuthenticatedDataReview[]=[];
  for (const {operation_key} of reviews.rows) {
   const operation=await operations.get(operation_key);
   if(operation?.state!=='complete') return fail();
   const review=operation.result as AuthenticatedDataReview;
   if(review.decision!=='approved')continue;
   const request=await operations.get(`data-review-request:${review.requestDigest}`);
   if(request?.state!=='complete')return fail();
   const snapshot=request.result as {task:ProductionDataInput['task'];candidates:DataBatch};
   if(canonicalJson(snapshot.task)!==canonicalJson(task.spec)||review.requestDigest!==dataReviewRequestDigest(snapshot.task,snapshot.candidates)
    ||request.digest!==reviewDigest(snapshot))return fail();
   const receipt=await operations.get(`data-review-receipt:${review.receiptId}`);
   const authenticated=await operations.get(`authenticated-data-review:${review.requestDigest}`);
   const principal=(await tx.query<{email:string}>('SELECT email FROM customers WHERE id=$1',[review.principalId])).rows[0];
   if(review.authority!=='authenticated_human'||review.decision!=='approved'||!principal||!isOperator(principal.email)
    ||review.principalId===task.spec.targetId||review.data.cases.some(c=>c.generatorId===review.principalId||c.verification&&c.verification.verifierId!==review.principalId)
    ||review.data.sources.some(s=>s.provenance.producerId===review.principalId||s.review.reviewerId!==review.principalId)
    ||operation.digest!==review.requestDigest||operation_key!==`${prefix}:review:${review.requestDigest}`||receipt?.state!=='complete'||authenticated?.state!=='complete'
    ||canonicalJson(receipt.result)!==canonicalJson(review)||canonicalJson(authenticated.result)!==canonicalJson(review)
    ||receipt.digest!==reviewDigest(review)||authenticated.digest!==reviewDigest(review)) return fail();
   approved.push(review);
  }
  if (task.cases.some(c=>!approved.some(r=>r.data.cases.some(x=>canonicalJson(x)===canonicalJson(c))))
   ||task.sources.some(s=>!approved.some(r=>r.data.sources.some(x=>canonicalJson(x)===canonicalJson(s))))) return fail();
  const receiptIds=approved.map(r=>r.receiptId).sort();
  const approvalArtifactId=`expert:${hash({freeze:freeze.digest,suite:frozen.digest,receiptIds})}`;
  const scope:TextContractScope={jobId:ctx.jobId,customerId:a.job.customerId,environment:ctx.environment,suiteDigest:frozen.digest,approvalArtifactId};
  // Credential changes require an explicit new run identity; no secret is retained in the binding.
  const targetVersion=hash(a.target),runId=`expert-${hash({scope,targetVersion}).slice(0,24)}`;
  return {...a,frozen,scope,targetVersion,runId};
 }
 const first=await authorized();
 const fixed=hash({scope:first.scope,targetVersion:first.targetVersion,runId:first.runId});
 async function current(tx:Tx=sql,value?:unknown) {
  await assertExpertTextStage(ctx.jobId,tx===sql?undefined:tx);
  const a=await authorized(tx);
  if(hash({scope:a.scope,targetVersion:a.targetVersion,runId:a.runId})!==fixed||value!==undefined&&!inspectDataSafety(value,a.secrets).safe) return fail();
  return a;
 }
 // This immutable owner row prevents a restarted worker from silently selecting a changed target/suite.
 await sql.transaction(async tx=>{
  const a=await current(tx);
  await tx.query(`INSERT INTO expert_workflow.text_bindings(job_id,scope,target_version,run_id) VALUES($1,$2::jsonb,$3,$4) ON CONFLICT DO NOTHING`,[ctx.jobId,JSON.stringify(a.scope),a.targetVersion,a.runId]);
  const binding=(await tx.query<{scope:TextContractScope;target_version:string;run_id:string}>('SELECT scope,target_version,run_id FROM expert_workflow.text_bindings WHERE job_id=$1 FOR UPDATE',[ctx.jobId])).rows[0];
  if(!binding||canonicalJson(binding.scope)!==canonicalJson(a.scope)||binding.target_version!==a.targetVersion||binding.run_id!==a.runId) return fail();
  await current(tx);
 });
 const artifacts=createNaiveArtifactStore({sql,authorize:async(tx,scope)=>{
  const a=await current(tx);if(scope.jobId!==a.scope.jobId||scope.customerId!==a.scope.customerId||scope.environment!==a.scope.environment
   ||scope.suiteDigest!==undefined&&scope.suiteDigest!==a.scope.suiteDigest||scope.approvalArtifactId!==undefined&&scope.approvalArtifactId!==a.scope.approvalArtifactId) return fail();
  return {knownSecrets:a.secrets};
 },decide:async(tx,_identity,suite)=>{const a=await current(tx);if(canonicalJson(suite)!==canonicalJson(a.frozen))return fail();return {status:'approved',approvalArtifactId:a.scope.approvalArtifactId};}});
 const admission=await artifacts.admission.admit({jobId:ctx.jobId,customerId:first.job.customerId,environment:ctx.environment,
  designId:`expert-${first.frozen.digest}`,versionLabel:first.frozen.versionLabel,inputDigest:hash({scope:first.scope})},first.frozen);
 if(admission.status!=='approved') return fail();
 const projection=projectFrozenTextSuite(first.frozen,first.scope,first.secrets);
 const rawRunner=deps.runner?fenceWorkflowStageRunner(deps.runner):(await buildAgentDeps({createBudgetLedger:createWorkflowStageBudgetLedger,decorateNaiveSessions:fenceWorkflowStageSessions,decorateAgentRunner:fenceWorkflowStageRunner})).runner;
 const runner:AgentTaskRunner={run:async spec=>{await current();const spent=Number((await sql.query<{spent:string}>('SELECT coalesce(sum(micro_usd),0)::text AS spent FROM costs WHERE job_id=$1',[ctx.jobId])).rows[0]?.spent??0);if(!Number.isSafeInteger(spent)||spent<0||spec.budgetMicroUsd>cap-spent)return fail();const result=await rawRunner.run(spec);if('cost' in result&&result.cost)await deliverSessionCost(result.cost,false);await current(sql,result);return result;}};
 async function resolved() {
  const a=await current();
  const model=process.env.NAIVE_JUDGE_MODEL;
  const reservation=Number(process.env.NAIVE_JUDGE_RESERVATION_MICRO_USD);
  const output=Number(process.env.NAIVE_JUDGE_MAX_OUTPUT_TOKENS);
  const proxyKey=process.env.NAIVE_API_KEY;
  if(!model||!proxyKey||!Number.isSafeInteger(reservation)||reservation<=0||!Number.isSafeInteger(output)||output<1)return fail();
  const baseUrl=process.env.NAIVE_BASE_URL;
  const judgeConfig={jobId:ctx.jobId,period:process.env.NAIVE_BUDGET_PERIOD_ID||new Date().toISOString().slice(0,7),jobCapMicroUsd:cap,judgeCapMicroUsd:JUDGE_MONTHLY_CAP_MICRO_USD};
  const judge=createAttemptAwareJudge(ctx,{jobId:ctx.jobId,model,maxOutputTokens:output,reservationMicroUsd:reservation,checkpoints,
   budget:createNaiveProxyBudget(createWorkflowStageBudgetLedger(sql),judgeConfig),
   client:idempotencyKey=>createClient({apiKey:proxyKey,...(baseUrl?{baseUrl}:{}),idempotencyKey:()=>idempotencyKey,fetch:deps.proxyFetch}),
   authorize:async()=>{const fresh=await current();if(process.env.NAIVE_JUDGE_MODEL!==model||process.env.NAIVE_API_KEY!==proxyKey||process.env.NAIVE_BASE_URL!==baseUrl||Number(process.env.NAIVE_JUDGE_RESERVATION_MICRO_USD)!==reservation||Number(process.env.NAIVE_JUDGE_MAX_OUTPUT_TOKENS)!==output)return fail();return {knownSecrets:fresh.secrets};}},{sql,config:judgeConfig,authorizeTransaction:async tx=>{await current(tx);if(process.env.NAIVE_JUDGE_MODEL!==model||process.env.NAIVE_API_KEY!==proxyKey||process.env.NAIVE_BASE_URL!==baseUrl||Number(process.env.NAIVE_JUDGE_RESERVATION_MICRO_USD)!==reservation||Number(process.env.NAIVE_JUDGE_MAX_OUTPUT_TOKENS)!==output)return fail();}});
  return {...a,retained:projection.retained,canonicalTarget:a.target,target:createTextTarget(a.target,deps.targetTransport),judge,knownSecrets:a.secrets};
 }
 const runService=createNaiveRunService({runner,checkpoints,resolve:resolved,persistRun:artifacts.persistRun});
 const investigationService=createNaiveInvestigationService({runner,checkpoints,resolve:async()=>{
  const a=await resolved();const retainedRun=await artifacts.loadRun(ctx,a.scope,a.runId,a.targetVersion);if(!retainedRun)return fail();return {...a,retainedSuite:projection.retained,retainedRun};
 },persistInvestigation:artifacts.persistInvestigation});
 return {suite:projection.suite,target:first.target,
  run:()=>runService.runSuite(ctx,projection.suite,first.target),
  investigate:(run:RunResult)=>investigationService.investigate(ctx,projection.suite,[run]),
  reportContext:async()=>{
   const a=await current();
   const retained=await artifacts.loadRun(ctx,a.scope,a.runId,a.targetVersion);
   const investigation=await checkpoints.get({jobId:ctx.jobId,kind:'naive_investigation_artifact',id:a.runId});
   if(!retained||investigation?.state!=='completed')return fail();
   const rich=(investigation.value as {investigation:{limitations:string[]}}).investigation;
   await current(sql,{retained,rich});
   const {projectTextSuiteRun}=await import('@ae/core/evals/naive-contract-mapping');
   const publicRun=projectTextSuiteRun(retained.run,projection,a.scope,a.secrets).result;
   const assessed=publicRun.results.filter(r=>r.assessment?.kind==='objective'||r.assessment?.kind==='rubric').length;
   const summary=publicRun.results.map(r=>`${r.scenarioId}: ${r.assessment?.kind??'objective'}; ${r.assessment?.checks.map(c=>`${c.checkId}=${c.status}${c.reason?` (${c.reason})`:''}`).join('; ')??''}`).join('\n');
   return {assessed,summary:`Text baseline assessment: ${assessed} of ${publicRun.results.length} scenarios assessed.\n${summary}\nLimitations: ${rich.limitations.join('; ')||'No additional investigator limitations.'}\nRemediation and rerun verification were not performed. Full target responses, check evidence, and reproductions are retained privately.`};
  },
  assertCurrent:async(value?:unknown)=>{await current(sql,value);}};
}
