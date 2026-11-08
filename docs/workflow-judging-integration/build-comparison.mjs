import{readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';import{execFileSync as exec}from'node:child_process';import{root}from'./stage.mjs';
let patch='';for(const name of ['rich-comparison.ts','comparison-production.ts']){const path='apps/web/src/server/'+name;const old=join(root,'docs/workflow-comparison-integration/app/files',path);let text=readFileSync(old,'utf8');
if(name==='rich-comparison.ts'){
text="import type { createTrustedJudgeResolver } from './rich-judge';\n"+text;
text=text.replace('  runner: AgentTaskRunner;','  runner: AgentTaskRunner;\n  judge?(binding: ComparisonBinding[\'current\']): ReturnType<typeof createTrustedJudgeResolver>;');
text=text.replace('judge:null,','judge:runtime.judge?.(v) ?? null,');
}else{
text="import { createTrustedJudgeResolver, workflowJudgePolicy, workflowJudgeRuntime, type TrustedJudgeRuntime } from './rich-judge';\nimport { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';\nimport { deliverRemediationCost } from './rich-remediation';\n"+text;
text=text.replace('comparisonProduction(jobId:string)','comparisonProduction(jobId:string, judgeRuntime?:TrustedJudgeRuntime)');
text=text.replace('  runner,knownSecrets:',`  judge: v => createTrustedJudgeResolver({sql,checkpoints:new PostgresTextCheckpointStore(sql),policy:workflowJudgePolicy(),runtime:judgeRuntime ?? sharedJudgeRuntime,deliverCost:deliverRemediationCost,canonical:async()=>{
   const {latest}=await endpoint(v);
   if(latest.job.state!=='delivered' || latest.job.isMock) return deny();
   const fixture=await sql.query<{fixture:boolean}>('SELECT is_internal_fixture AS fixture FROM customers WHERE id=$1',[latest.job.customerId]);
   return {job:{jobId,customerId:latest.job.customerId,environment:latest.job.environment,package:'text_eval' as const,isFixture:fixture.rows[0]?.fixture===true,linkedRetestOf:latest.job.retestOfJobId,quoteVersion:null},targetVersion:v.version,knownSecrets:Object.values(latest.credentials).filter((s):s is string=>typeof s==='string')};
  }}),
  runner,knownSecrets:`);
text=text.replace(' const config:ComparisonRuntime={',' const sharedJudgeRuntime=judgeRuntime ?? workflowJudgeRuntime();\n const config:ComparisonRuntime={');
}
const dest=join(root,'docs/workflow-judging-integration/app/files',path);writeFileSync(dest,text);try{exec('diff',['-u','--label','a/'+path,'--label','b/'+path,old,dest],{encoding:'utf8'});}catch(e){if(e.status!==1)throw e;patch+=e.stdout;}}
writeFileSync(join(root,'docs/workflow-judging-integration/app/006-comparison-judging.patch'),patch);
