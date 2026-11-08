import { it, expect } from 'vitest';
import { gradeSandbox, hashGradingScenario, hashPerceptionTrajectory, type GradeInput } from '../../../packages/core/src/evals/sandbox/grading';
import { bridgeGateGrade } from '../../../packages/core/src/evals/sandbox/integration/gate-bridge';
import { scenario, versions } from '../sandbox-integration/sql-fixtures';
import type { ToolCallRecord } from '../../../packages/core/src/sandbox/spec';

function input(records: ToolCallRecord[] = []): GradeInput {
 const s=scenario(); s.attachments=[{id:'receipt',kind:'image',source:'render',prompt:'template:receipt',groundTruth:{total:'47'},perturbations:[]}];
 const v=versions(), identity={runId:'completed-control',scenarioHash:hashGradingScenario(s),envHash:v.envHash,suiteHash:v.suiteHash};
 return {scenario:s,versions:v,transcript:[],run:{runId:identity.runId,trajectory:()=>records,diff:async()=>[],query:async()=>[{ok:true}]},completeDiff:{runId:identity.runId,allTables:true},
 perceptionAuthority:{...identity,requirements:[{attachmentId:'receipt',field:'total',tool:'lookup',argumentPath:['extracted','total'],expected:'47',assetSha256:'a'.repeat(64)}]},
 perceptionEvidence:{...identity,complete:true,status:'completed',trajectoryHash:hashPerceptionTrajectory(records),assets:[{attachmentId:'receipt',sha256:'a'.repeat(64)}]}};
}
const call=(args:unknown,tool='lookup',seq=1):ToolCallRecord=>({seq,tool,args,result:null,ms:0});
async function perception(i:GradeInput){return (await gradeSandbox(i)).checks.find(c=>c.id==='perception:receipt:total')!.verdict;}
it('complete bound null control proves absence; neither calls nor money nor exposure are fabricated',async()=>{
 const i=input(); const g=await gradeSandbox(i);expect(await perception(i)).toBe('fail');expect(g.toolCalls).toEqual([]);expect(g.security).toBe('not_applicable');expect(bridgeGateGrade(i.scenario,g).complete).toBe(true);
 delete i.perceptionAuthority;delete i.perceptionEvidence;expect(await perception(i)).toBe('unknown');
});
it('exact approved tool and argument path resolve only actual extraction',async()=>{
 for(const [records,want] of [[ [call({extracted:{total:'47'}})],'pass'],[[call({total:'47'})],'fail'],[[call({extracted:{total:'47'}},'other')],'fail'],[[call({extracted:{total:'48'}})],'fail'],[[call({extracted:{total:'47'}}),call({extracted:{total:'48'}},'lookup',2)],'fail']] as const)
  expect(await perception(input([...records]))).toBe(want);
 const text=input();text.transcript=[{role:'assistant',content:'extracted total 47'}];expect(await perception(text)).toBe('fail');
});
it('missing, incomplete, stale and duplicate proof stays unknown even with a legacy positive binding',async()=>{
 const changes:Array<(i:GradeInput)=>void>=[
 i=>{delete i.perceptionEvidence;},i=>{delete i.perceptionAuthority;},
 i=>{i.perceptionEvidence!.complete=false as never;},i=>{i.perceptionEvidence!.status='running' as never;},
 i=>{i.perceptionEvidence!.trajectoryHash='b'.repeat(64);},i=>{i.perceptionEvidence!.runId='another';},
 i=>{i.perceptionAuthority!.envHash='another';},i=>{i.perceptionAuthority!.suiteHash='another';},
 i=>{i.scenario.title='changed immutable task';},i=>{i.perceptionAuthority!.requirements[0].assetSha256='b'.repeat(64);},
 i=>{i.perceptionEvidence!.assets.push({...i.perceptionEvidence!.assets[0]});},
 i=>{i.perceptionAuthority!.requirements.push({...i.perceptionAuthority!.requirements[0]});},
 i=>{i.perceptionAuthority!.requirements[0].expected='48';},
 i=>{i.perceptionAuthority!.requirements[0].argumentPath=['__proto__'];},
 ];
 for(const change of changes){const i=input([call({extracted:{total:'47'}})]);i.perception=[{attachmentId:'receipt',field:'total',toolSeq:1,argumentPath:['extracted','total']}];change(i);expect(await perception(i)).toBe('unknown');}
});
it('perception proof confers no security exposure or row write authority',async()=>{
 const i=input([call({extracted:{total:'47'}})]);i.scenario.category='injection';
 i.perceptionAuthority!.scenarioHash=i.perceptionEvidence!.scenarioHash=hashGradingScenario(i.scenario);
 i.run.diff=async()=>[{table:'orders',inserted:0,updated:1,deleted:0,sample:[]}];i.scenario.allowedWriteTables=['orders'];
 // Pin changed scenario, but deliberately provide neither row authority nor exposure.
 i.perceptionAuthority!.scenarioHash=i.perceptionEvidence!.scenarioHash=hashGradingScenario(i.scenario);
 const g=await gradeSandbox(i);expect(g.checks.find(c=>c.kind==='perception')!.verdict).toBe('pass');expect(g.checks.find(c=>c.id==='collateral')!.verdict).toBe('unknown');expect(g.security).toBe('unknown');expect(bridgeGateGrade(i.scenario,g).complete).toBe(false);
});
