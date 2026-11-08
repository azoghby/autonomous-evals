import{readFileSync,writeFileSync,mkdirSync,cpSync}from'node:fs';import{join}from'node:path';import{execFileSync as exec}from'node:child_process';import{stageBase,root}from'./stage.mjs';
const {stage}=await stageBase();const files=join(root,'docs/workflow-judging-integration/app/files');
for(const file of ['rich-services.ts','rich-remediation.ts']){const p='apps/web/src/server/'+file;let text=readFileSync(join(stage,p),'utf8');
 if(file==='rich-services.ts'){
 text="import { createTrustedJudgeResolver, workflowJudgePolicy, workflowJudgeRuntime, type TrustedJudgeRuntime } from './rich-judge';\nimport { deliverRemediationCost } from './rich-remediation';\n"+text;
 text=text.replace('authority: { workflowRunId: string }','authority: { workflowRunId: string; judgeRuntime?: TrustedJudgeRuntime }');
 text=text.replace('  const initial = await canonical();',`  const judgeRuntime = authority.judgeRuntime ?? workflowJudgeRuntime();
  const judge = createTrustedJudgeResolver({ sql, checkpoints: new PostgresTextCheckpointStore(sql), canonical,
    policy: workflowJudgePolicy(), runtime: { ...judgeRuntime, beforeDispatch: async intent => {
      if (ctx.budgetMicroUsd <= 0) return refused();
      await judgeRuntime.beforeDispatch(intent);
    } }, deliverCost: deliverRemediationCost });
  const initial = await canonical();`);
 if(!text.includes('judge: null'))throw Error('Text seam moved');text=text.replace(/judge: null, knownSecrets: a.knownSecrets[^\n]*/, 'judge, knownSecrets: a.knownSecrets };');
 text=text.replace('canonical, text });','canonical, text, judge });');
 }else{
 text="import type { createTrustedJudgeResolver } from './rich-judge';\n"+text;
 text=text.replace('  text: ReturnType<typeof createTextEvaluationServices>;','  text: ReturnType<typeof createTextEvaluationServices>;\n  judge?: ReturnType<typeof createTrustedJudgeResolver>;');
 text=text.replace('trial, judge: null,','trial, judge: deps.judge ? async input => ({ value: await deps.judge!(input), costs: [] }) : null,');
 text=text.replace("op.kind === 'target' && enabled ? accounting.authorize(op) : false", "op.kind === 'judge' ? Boolean(deps.judge) : enabled ? accounting.authorize(op) : false");
 text=text.replace('// No Gateway judge is configured: rubric checks stay unassessed, never silently passed.','// The shared secured judge owns its durable reservation, usage and keyed delivery.');
 }
 mkdirSync(join(files,'apps/web/src/server'),{recursive:true});writeFileSync(join(files,p),text);
}
let patch='';for(const name of ['judge-accounting.ts','rich-judge.ts','rich-services.ts','rich-remediation.ts']){const p='apps/web/src/server/'+name;const added=['judge-accounting.ts','rich-judge.ts'].includes(name);try{exec('diff',['-u','--label',added?'/dev/null':'a/'+p,'--label','b/'+p,added?'/dev/null':join(stage,p),join(files,p)],{encoding:'utf8'});}catch(e){if(e.status!==1)throw e;patch+=e.stdout;}}
writeFileSync(join(root,'docs/workflow-judging-integration/app/005-judging.patch'),patch.replace(/^ $/gm,''));console.log(stage);
