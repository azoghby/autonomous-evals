import { it, expect } from 'vitest';
import { pinMediaPlan, validateMediaPlan, mediaPlanIdentity, type EngineMediaPlan, type EngineMediaPorts } from '../../../packages/core/src/evals/sandbox/integration/media';
import { trialInput } from '../sandbox-integration/sql-fixtures';
import { executionDigest } from '../../../packages/core/src/evals/sandbox/execution/runner';
function fixture() {
 const input=trialInput(); input.scenario.persona.modality='voice';
 input.scenario.persona.voice={ttsModel:'fixture-tts',voiceId:'alloy',pace:'normal',interrupts:false};
 input.scenario.persona.knowledge=[{fact:'Order 47',revealWhen:'upfront'},{fact:'hidden fact',revealWhen:'when_asked'}];
 const plan:EngineMediaPlan={kind:'voice',input:{text:'Order 47',facts:{order:'47'},voice:input.scenario.persona.voice,sttModel:'fixture-stt',target:{endpointUrl:'https://example.com/v1/chat/completions',model:input.agentModel},maxAudioBytes:10000,maxToolRounds:2,maxToolCalls:2,maxElapsedMs:1000,maxInputWer:0}};
 return {input,plan};
}
it('pins detached plan data before awaits and retains only trusted receipt validator by reference',()=>{
 const {plan}=fixture(), pinned=pinMediaPlan(plan), digest=executionDigest(mediaPlanIdentity(pinned));
 plan.input.text='replacement';expect(executionDigest(mediaPlanIdentity(pinned))).toBe(digest);
 const validateToolArgs=()=>{};
 const receipt:EngineMediaPlan={kind:'receipt',input:{operationId:'not-allowed'} as never,target:{endpointUrl:'https://example.com',model:'fixture',tools:[],maxToolCalls:1,maxToolRounds:1,validateToolArgs}};
 const detached=pinMediaPlan(receipt);receipt.target.model='changed';expect(detached.kind==='receipt' && detached.target.model).toBe('fixture');
 expect(detached.kind==='receipt' && detached.target.validateToolArgs).toBe(validateToolArgs);
 expect(()=>executionDigest(mediaPlanIdentity(detached))).not.toThrow();
});
it('rejects hidden voice facts, target/schema/spec drift and invalid bounds before runtime dispatch',()=>{
 const ports={} as EngineMediaPorts;
 const {input,plan}=fixture();expect(validateMediaPlan(input,plan,ports)).toBe(executionDigest(plan.input.target));
 expect(()=>validateMediaPlan({...input,versions:{...input.versions,spec:'other' as never}},plan,ports)).toThrow('spec');
 expect(()=>validateMediaPlan({...input,bounds:{...input.bounds,maxToolCalls:0}},plan,ports)).toThrow('bounds');
 expect(()=>validateMediaPlan(input,{...plan,input:{...plan.input,text:'hidden fact',facts:{hidden:'hidden fact'}}},ports)).toThrow('not_admitted');
 expect(()=>validateMediaPlan(input,{...plan,input:{...plan.input,target:{...plan.input.target,endpointUrl:'https://another.example'}}},ports)).toThrow('target');
 expect(()=>validateMediaPlan(input,{...plan,input:{...plan.input,target:{...plan.input.target,tools:[{type:'function',function:{name:'lookup',parameters:{type:'string'}}}]}}},ports)).toThrow('schema');
});
