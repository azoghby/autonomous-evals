import { createTrustedJudgeResolver, workflowJudgePolicy, workflowJudgeRuntime, type TrustedJudgeRuntime } from './rich-judge';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import { deliverRemediationCost } from './rich-remediation';
import 'server-only';
import { createHash } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { containsSecret } from '@ae/core/agents/redact';
import { Suite, IntakeInput } from '@ae/core/contracts/index';
import { buildAgentDeps, evalServices } from '@ae/core/integration/eval-services';
import { readJobArtifactText } from '@ae/core/storage/blob';
import { createTextTarget } from '@ae/core/targets/text';
import { platformTarget } from '@ae/core/targets/adapters';
import { createCalendarEvaluationServices } from '@ae/core/evals/calendar-integration/index';
import { PostgresBranchLedger } from '@ae/core/simulator/branch-ledger';
import { pooledCalendarDatabase } from '@ae/core/simulator/pool';
import { CalendarSimulator } from '@ae/core/simulator/calendar';
import { PostgresCalendarStore } from '@ae/core/simulator/postgres';
import { getJobWithDecryptedCredentials } from './job-store';
import { workflowSql } from './rich-services';
import { createRichComparisonApp, comparisonDigest, type ComparisonBinding, type ComparisonRuntime } from './rich-comparison';
const deny=():never=>{throw new Error('rich_comparison_configuration_refused');};
/** No network performed by construction. Credentials remain in this internal closure. */
export async function comparisonProduction(jobId:string, judgeRuntime?:TrustedJudgeRuntime) {
 const sql=workflowSql(); const initial=await getJobWithDecryptedCredentials(jobId); if(!initial) return deny();
 const runner=(await buildAgentDeps()).runner; const pools:Pool[]=[];
 const endpoint=async(v:ComparisonBinding['current'])=>{
  const latest=await getJobWithDecryptedCredentials(jobId); if(!latest || latest.job.customerId!==initial.job.customerId || latest.job.environment!==initial.job.environment) return deny();
  const canonicalEndpoint=(IntakeInput.parse(latest.intake) as unknown as Record<string,unknown>)[v.endpointSlot] as {url:string;model:string;apiKey?:string;systemPrompt:string}|undefined;
  const ep=canonicalEndpoint?{...canonicalEndpoint,...v.endpointOverride}:undefined;
  const cred=await sql.query<{ciphertext:string}>('SELECT ciphertext FROM job_credentials WHERE job_id=$1',[jobId]);
  if(!ep || comparisonDigest({endpoint:{...ep,apiKey:undefined},credentialCiphertext:cred.rows[0]?.ciphertext??null})!==v.configurationDigest) return deny();
  return {latest,ep};
 };
 const sharedJudgeRuntime=judgeRuntime ?? workflowJudgeRuntime('comparison');
 const config:ComparisonRuntime={
  judge: v => createTrustedJudgeResolver({sql,checkpoints:new PostgresTextCheckpointStore(sql),policy:workflowJudgePolicy(),runtime:judgeRuntime ?? sharedJudgeRuntime,deliverCost:deliverRemediationCost,canonical:async()=>{
   const {latest}=await endpoint(v);
   if(latest.job.state!=='delivered' || latest.job.isMock) return deny();
   const fixture=await sql.query<{fixture:boolean}>('SELECT is_internal_fixture AS fixture FROM customers WHERE id=$1',[latest.job.customerId]);
   return {job:{jobId,customerId:latest.job.customerId,environment:latest.job.environment,package:'text_eval' as const,isFixture:fixture.rows[0]?.fixture===true,linkedRetestOf:latest.job.retestOfJobId,quoteVersion:null},targetVersion:v.version,knownSecrets:Object.values(latest.credentials).filter((s):s is string=>typeof s==='string')};
  }}),
  runner,knownSecrets:Object.values(initial.credentials).filter((s):s is string=>typeof s==='string'),
  verify:async(id,b,retained)=>{
   if(id!==jobId || Object.values(initial.credentials).some(s=>typeof s==='string'&&s.length<4) || containsSecret(JSON.stringify({binding:b,retained}),Object.values(initial.credentials))) return deny();
   const {latest}=await endpoint(b.current); const base=await endpoint(b.baseline);
   if(b.current.version!==b.current.configurationDigest)return deny();
   const revision=await sql.query<{target_revision:string}>('SELECT target_revision FROM workflow_integration.bindings WHERE job_id=$1',[jobId]);
   const ciphertext=await sql.query<{ciphertext:string}>('SELECT ciphertext FROM job_credentials WHERE job_id=$1',[jobId]);
   const baselineVersion=createHash('sha256').update(JSON.stringify({endpoint:{...base.ep,apiKey:undefined},revision:revision.rows[0]?.target_revision,credentialCiphertext:ciphertext.rows[0]?.ciphertext??null})).digest('hex');
   if(retained.kind==='text' ? b.baseline.version!==baselineVersion : b.baseline.targetId!==`target:${baselineVersion}`)return deny();
   const applicationIds=new Set<string>();
   if(latest.job.suiteBlobPath){
    const text=await readJobArtifactText(latest.job.suiteBlobPath);if(text===null)return deny();
    for(const s of Suite.parse(JSON.parse(text)).scenarios)applicationIds.add(s.id);
   }else{
    // Original rich producer publishes this complete expected inventory before dispatch; it does not write a legacy Suite blob.
    const inventory=await sql.query<{plan:{checkpoints:{scenarioIds?:string[]}[]}}>('SELECT plan FROM structured_progress.inventory WHERE job_id=$1 AND tenant_id=$2 AND environment=$3',[jobId,latest.job.customerId,latest.job.environment]);
    if(!inventory.rows[0])return deny();
    for(const cp of inventory.rows[0].plan.checkpoints)for(const id of cp.scenarioIds??[])applicationIds.add(id);
   }
   const packTable=await sql.query<{present:string|null}>("SELECT to_regclass('workflow_integration.pack_approvals')::text AS present");
   if(packTable.rows[0]?.present){
    const packs=await sql.query<{manifest:{inventory:{id:string}[]}}>('SELECT manifest FROM workflow_integration.pack_approvals WHERE job_id=$1',[jobId]);
    for(const pack of packs.rows)for(const entry of pack.manifest.inventory)applicationIds.add(entry.id);
   }
   const original=await sql.query<{body:Record<string,unknown>}>(`SELECT a.body FROM workflow_integration.rich_artifacts a JOIN jobs j ON j.id=a.job_id AND j.customer_id=a.tenant_id AND j.environment=a.environment WHERE j.id=$1`,[jobId]);
   const body=original.rows[0]?.body;
   const appended=body?.appendedPack as {manifest?:{inventory?:{id:string}[]}}|undefined;
   for(const entry of appended?.manifest?.inventory??[])applicationIds.add(entry.id); if(!body || comparisonDigest(body.suite)!==comparisonDigest(retained.suite) || comparisonDigest(body.run)!==comparisonDigest(retained.run) || comparisonDigest(body.investigation)!==comparisonDigest(retained.investigation)) return deny();
   if(retained.kind==='text') {
    const identity=await sql.query<{value:{targetVersion?:string}}>("SELECT value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='run_identity' AND id=$2 AND state='completed'",[jobId,retained.run.runId]);
    if(identity.rows[0]?.value.targetVersion!==b.baseline.version || b.baseline.branchId!==null || b.current.branchId!==null) return deny();
   } else if(retained.run.branchId!==b.baseline.branchId || retained.run.versionLabel!==b.baseline.version) return deny();
   return {scenarioIds:[...applicationIds]};
  },
  target:async v=>createTextTarget((await endpoint(v)).ep),
  calendar:async(v,guard,checkpoints)=>{
   if(!v.branchId) return deny();
   const journalPool=new Pool({connectionString:process.env.DATABASE_URL,max:2}); pools.push(journalPool);
   let sequence=0;
   return createCalendarEvaluationServices({checkpoints,journalPool,resolve:async()=>{
    const {latest,ep}=await endpoint(v);
    const branch=await new PostgresBranchLedger(journalPool).findOwnedBranch(v.branchId!);
    if(!branch || branch.jobId!==jobId || branch.state!=='ready') return deny();
    const conn=await evalServices.getJobBranchConnection!(v.branchId!);
    const pool=new Pool({connectionString:conn,max:2}); pools.push(pool); const db=pooledCalendarDatabase(pool);
    const saved=await sql.query<{suite:Record<string,unknown>;retained:{run:{systemPrompt?:string}}}>('SELECT suite,retained FROM workflow_comparison.bindings WHERE job_id=$1',[jobId]);
    const {hash:_,...reviewed}=saved.rows[0]!.suite;
    return {job:{jobId,customerId:latest.job.customerId,environment:latest.job.environment,package:'workflow_eval' as const,isFixture:false,linkedRetestOf:null,quoteVersion:null},targetVersion:v.version,branch:{jobId,branchId:v.branchId!,targetVersion:v.version},systemPrompt:saved.rows[0]!.retained.run.systemPrompt,reviewedSuite:reviewed as unknown as Parameters<typeof import('@ae/core/simulator/workflow/index').freezeCalendarSuite>[0],knownSecrets:Object.values(latest.credentials),
      dependencies:{db,simulator:new CalendarSimulator(new PostgresCalendarStore(db)),targetForScenario:scope=>({complete:async(messages,tools)=>{
       await guard(`${scope.id}:${sequence++}`); await endpoint(v);
       const again=await new PostgresBranchLedger(journalPool).findOwnedBranch(v.branchId!); if(!again || again.jobId!==jobId || again.state!=='ready') return deny();
       return platformTarget(ep).complete(messages,tools);
      }})}};
   }});
  },
 };
 const app=createRichComparisonApp(sql,config);
 return {app,verify:config.verify,dispose:async()=>{await Promise.all(pools.map(p=>p.end()));}};
}
