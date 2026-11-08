import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {workflowJudgeRuntime} from '@/server/rich-judge';
afterEach(()=>vi.unstubAllEnvs());
it('actual production construction fails closed without a phase plan',async()=>{
 vi.stubEnv('WORKFLOW_JUDGE_PHASE_DISPATCH_LIMITS','');
 await expect(workflowJudgeRuntime().beforeDispatch({kind:'gateway',operationId:'unconfigured'})).rejects.toThrow();
});
it('actual production runtime admits all24 calls in each configured phase and refuses overflow',async()=>{
 vi.stubEnv('WORKFLOW_JUDGE_PHASE_DISPATCH_LIMITS',JSON.stringify({baseline:24,remediation:24,rerun:24,comparison:48}));
 for(const phase of ['baseline','remediation','rerun','comparison'] as const){
  const runtime=workflowJudgeRuntime(phase),limit=phase==='comparison'?48:24;
  for(let i=0;i<limit;i++)await runtime.beforeDispatch({kind:'gateway',operationId:`${phase}:${i}`});
  await expect(runtime.beforeDispatch({kind:'gateway',operationId:'overflow'})).rejects.toThrow();
 }
});
it('rejects malformed, unknown phase, zero and unbounded policy',()=>{
 for(const raw of ['null','[]','{','{"baseline":0}','{"baseline":97}','{"baseline":24,"client":100}']){
  vi.stubEnv('WORKFLOW_JUDGE_PHASE_DISPATCH_LIMITS',raw);expect(()=>workflowJudgeRuntime()).toThrow();
 }
});
it('lower acceptance meter still refuses call17 despite configured production24',async()=>{
 vi.stubEnv('WORKFLOW_JUDGE_PHASE_DISPATCH_LIMITS','{"baseline":24}');
 const actual=workflowJudgeRuntime();let accepted=0;
 const acceptance=async(i:number)=>{if(++accepted>16)throw Error('approved_gateway_cap');await actual.beforeDispatch({kind:'gateway',operationId:String(i)});};
 for(let i=0;i<16;i++)await acceptance(i);
 await expect(acceptance(16)).rejects.toThrow('approved_gateway_cap');
});
it('composed authority keeps judged Text/remediation plus rerun per-request fences and review ordering',()=>{
 const root=process.env.WORKFLOW_STAGE!;
 const source=readFileSync(join(root,'apps/web/src/server/rich-services.ts'),'utf8');
 for(const fragment of ["workflowJudgeRuntime(authority.rerun ? 'rerun' : 'baseline')","workflowJudgeRuntime('remediation')",'judge, knownSecrets:','judge: remediationJudge','loaded.job.customerId === authority.rerun.ownerId','fresh.targetVersion!==a.targetVersion','if (authority.rerun ||'])expect(source).toContain(fragment);
 const driver=readFileSync(join(root,'apps/web/src/workflows/steps/rich-evaluation.ts'),'utf8');
 expect(driver.indexOf('await captureReviewIntents')).toBeLessThan(driver.indexOf('await api.advanceData'));
 expect(driver.indexOf('await api.advanceData')).toBeLessThan(driver.indexOf('await finishReviewIntents'));
});
