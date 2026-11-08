import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const ts=require('typescript');
const path='docs/workflow-judging-integration/app/files/apps/web/src/server/rich-judge.ts';
const source=readFileSync(path,'utf8');
const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='workflowJudgeRuntime');
assert.ok(fn,'actual runtime factory must exist');
const js=ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const context={exports:{},AbortSignal,process:{env:{}},refuse:()=>{throw Error('judge_reconciliation_required');}};
vm.runInNewContext(js,context);
const runtime=context.exports.workflowJudgeRuntime();
let accepted=0;
for(let i=0;i<24;i++){
 try{await runtime.beforeDispatch({kind:'gateway',operationId:`readiness:${i}`});accepted++;}
 catch(e){assert.equal(e.message,'judge_reconciliation_required');}
}
const artifact=JSON.parse(readFileSync('packages/core/src/evals/text/__tests__/evidence/text-design-v3-2026-11-07.json','utf8'));
const required=artifact.outcome.suite.scenarios.reduce((n,s)=>n+s.rubricChecks.length,0);
assert.equal(required,24);assert.equal(accepted,16);
console.log(JSON.stringify({characterization:true,releaseAcceptance:false,source:path,requiredRubricChecks:required,defaultRuntimeDispatches:accepted,shortfall:required-accepted,networkCalls:0},null,2));
