import { mediaPlanIdentity } from '../../../packages/core/src/evals/sandbox/integration/media';
import { ActualMediaRuntime } from './actual-runtime';
import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSandboxEngine, type SandboxEngineConfig, type PrivateSandboxReport } from '../../../packages/core/src/evals/sandbox/integration';
import { createReceiptChatTarget } from '../../../packages/core/src/evals/sandbox/multimodal/vision';
import { FileMediaAuthority, createMediaTransport } from '../../../packages/core/src/evals/sandbox/multimodal/common';
import { executionDigest } from '../../../packages/core/src/evals/sandbox/execution/runner';
import { gradeSandbox } from '../../../packages/core/src/evals/sandbox/grading';
import { bridgeGateGrade } from '../../../packages/core/src/evals/sandbox/integration/gate-bridge';
import { freezeSandboxInputs } from '../../../packages/core/src/evals/sandbox/identity';
import { createSuiteGateArtifact, runScenarioGates, gateDigest, requiredGateCheckIds, type CustomerSuiteApproval } from '../../../packages/core/src/evals/sandbox/generation/gates';
import { gateFixture, environment, trialInput, versions } from '../sandbox-integration/sql-fixtures';
import { SqlWorld, gateReplay, checkpointDatabase } from '../sandbox-integration/sql-world';

const wav = () => { const b = Buffer.alloc(48); b.write('RIFF'); b.write('WAVE',8); return b.toString('base64'); };
for (const kind of ['receipt','voice'] as const) it(`${kind}: admitted SQL lifecycle, pre-disposal snapshot, private delivery and durable restart`, async () => {
 const root = await mkdtemp(join(tmpdir(),'engine-media-')), f = await gateFixture();
 let dispatched=0, stt=0, authorized=true, lose=true, approval: CustomerSuiteApproval | null=null;
 const reports: PrivateSandboxReport[]=[]; const events:string[]=[];const runtime=new ActualMediaRuntime(events);
 const persistent=await checkpointDatabase(join(root,'sql'));
 try {
 const environment=structuredClone(f.input.environment);
 if(kind==='receipt')environment.tools[0].inputSchema={type:'object',properties:{total:{type:'string'}},required:['total'],additionalProperties:false};
 const s=structuredClone(f.s); s.persona.modality=kind==='voice'?'voice':'multimodal';
 if(kind==='voice')s.persona.knowledge=[{fact:'Quote 47',revealWhen:'upfront'}];
 if(kind==='voice')s.persona.voice={ttsModel:'fixture-tts',voiceId:'alloy',pace:'normal',interrupts:false};
 if(kind==='receipt')s.attachments=[{id:'receipt',kind:'image',source:'render',prompt:'template:receipt',groundTruth:{total:'47'},perturbations:[]}];
 // Gates run actual SQL, actual deterministic grader and actual mutations. The gate agent
 // here is a controlled reference fixture; media SDK fidelity is exercised in the trial.
 const execute=f.ports.execute;
 f.ports.execute=async i=>{const r=await execute(i); if(kind==='receipt'){if(i.role==='dump')await i.run.callTool('lookup',{});(i.run as SqlWorld).records[0].args={total:i.role==='oracle'?'47':'48'};} return r;};
 f.ports.grade=async i=>bridgeGateGrade(i.scenario,await gradeSandbox({scenario:i.scenario,run:i.run,versions:versions(),transcript:i.execution.transcript,
 completeDiff:{runId:i.run.runId,allTables:true},perception:kind==='receipt'?[{attachmentId:'receipt',field:'total',toolSeq:1,argumentPath:['total']}]:[]}));
 f.ports.mutations=async()=>requiredGateCheckIds(s).map(id=>({id:id.replace(':','_'),targetCheckId:id}));
 const mutate=f.ports.mutate; f.ports.mutate=async i=>{const r=await mutate(i);if(kind==='receipt' && i.plan.targetCheckId==='trajectory:read')(r.run as SqlWorld).records=i.oracleRun.trajectory().map(c=>({...c,tool:'other'}));if(i.plan.targetCheckId==='media:receipt')(r.run as SqlWorld).records[0].args={total:'48'};return r;};
 const makeTransport=()=>createMediaTransport({authority:new FileMediaAuthority(join(root,'dispatch')),allowedUrls:['https://ai-gateway.vercel.sh/v4/ai/language-model','https://ai-gateway.vercel.sh/v4/ai/speech-model','https://ai-gateway.vercel.sh/v4/ai/transcription-model','https://example.com/v1/chat/completions'],authorize:async()=>{},token:async()=> 'offline-credential',secrets:['offline-credential'],maxRequestBytes:2000000,maxResponseBytes:100000,timeoutMs:5000,maxMicroUsd:10,meter:{reserve:async()=>{},observed:async()=>{}},fetchImpl:async(url,init)=>{
 dispatched++;const body=JSON.parse(String(init?.body));
 if(String(url).endsWith('/speech-model'))return Response.json({audio:wav()});
 if(String(url).endsWith('/transcription-model'))return Response.json({text:stt++===0?'Quote 47':'47'});
 if(String(url).endsWith('/language-model'))return Response.json({content:[{type:'text',text:JSON.stringify({fields:{total:'47'},other_text:[]})}],finishReason:{unified:'stop',raw:'stop'},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}},warnings:[]});
 expect(JSON.stringify(body.messages)).toContain(kind==='receipt'?'data:image/png;base64,':'input_audio');
 const hasTool=body.messages.some((m:{role:string})=>m.role==='tool');
 return Response.json({choices:[{finish_reason:hasTool?'stop':'tool_calls',message:{role:'assistant',content:hasTool?'47':null,...(hasTool?(kind==='voice'?{audio:{data:wav()}}:{}):{tool_calls:[{id:'read',type:'function',function:{name:'lookup',arguments:kind==='receipt'?' {"total":"47"}':'{}'}}]})}}]});
 }});
 const target={endpointUrl:'https://example.com/v1/chat/completions',model:'offline-agent-v1',maxToolRounds:3,maxToolCalls:2,tools:[{name:'lookup',description:'Read quote',parameters:environment.tools[0].inputSchema as Record<string,unknown>}],validateToolArgs:(_n:string,args:unknown)=>{expect(args).toEqual({total:'47'});}};
 const voiceTarget={endpointUrl:target.endpointUrl,model:target.model,tools:[{type:'function',function:target.tools[0]}]};
 const transport=makeTransport();
 const digest=kind==='receipt'?createReceiptChatTarget({...target,transport,callTool:async()=>{throw Error('unused');}}).configDigest:executionDigest(voiceTarget);
 const config:SandboxEngineConfig={scope:f.input.scope,generation:{job:{jobId:'sql-job',customerId:'owner',package:'workflow_eval',environment:'test',isFixture:true,quoteVersion:null,linkedRetestOf:null},runner:{} as never,sessionCapMicroUsd:1,jobCapMicroUsd:1,bindOperation:async()=> 'bound',onMeasuredCost:async()=>{}},gateVersions:f.input.versions,gateEvalVersions:versions(),gates:f.ports,gateEvidence:async({run})=>({completeDiff:{runId:run.runId,allTables:true}}),approvals:{resolve:async()=>approval},execution:{runtime,checkpoints:persistent.store,authorizeTrial:async()=>true,simulator:{model:'offline-sim-v1',configDigest:'offline-sim-config-v1',next:async()=>{throw Error('media must not call text simulator');}},target:()=>{throw Error('media must not call text target');}},
 media:{plan:input=>{runtime.input=structuredClone(input);return kind==='receipt'?{kind,input:{attachment:s.attachments[0],oracleModel:'independent-oracle',targetModel:target.model,seed:42,maxBytes:2000000},target}:{kind,input:{text:'Quote 47',facts:{amount:'47'},voice:s.persona.voice!,sttModel:'independent-stt',target:voiceTarget,maxAudioBytes:10000,maxToolRounds:2,maxToolCalls:2,maxElapsedMs:5000,maxInputWer:0}};},bridge:{authority:new FileMediaAuthority(join(root,'bridge')),authorize:async()=>{},transport,secrets:['offline-credential'],maxArtifactBytes:100000,timeoutMs:5000},captureFinalSnapshot:async({run,execution})=>{expect(runtime.disposed.has(run.runId)).toBe(false);events.push('capture');await runtime.handles.get(run.runId)!.seal();expect(execution.runId).toBe(run.runId);}},
 authority:{authorize:async()=>authorized,replay:gateReplay(persistent.store),finalSnapshot:async a=>{events.push('grade');expect(runtime.disposed.has(a.runId!)).toBe(true);const snapshot=await runtime.handles.get(a.runId!)!.finalSnapshot(a);return{...snapshot,evidence:{...snapshot.evidence,perception:kind==='receipt'?[{attachmentId:'receipt',field:'total',toolSeq:1,argumentPath:['total']}]:[]}};},persistPrivateReport:async report=>{reports.push(report);if(lose){lose=false;throw Error('lost acknowledgement');}}}};
 const engine=createSandboxEngine(config);
 // Use the actual media grader for proposal as well.
 config.gateEvidence=async({run})=>({completeDiff:{runId:run.runId,allTables:true},perception:kind==='receipt'?[{attachmentId:'receipt',field:'total',toolSeq:1,argumentPath:['total']}]:[]});
 // Receipt admission is a trusted protocol fixture: current deterministic perception
 // treats absent null-control arguments as unknown, so it cannot admit that suite.
 // The production lifecycle below still uses the actual deterministic SQL grader.
 const gateInput={...f.input,environment,scenario:s,replayKey:'receipt-admission-fixture'};
 const artifact=kind==='voice'?await engine.propose({environment,scenarios:[s],operationKey:'media-suite'}):createSuiteGateArtifact({scope:f.input.scope,environment,scenarios:[s],evidence:[await runScenarioGates(gateInput,{...f.ports,grade:async i=> /\/(do_nothing|empty|dump)$/.test(i.execution.evidenceRef ?? '')?{complete:true,checks:requiredGateCheckIds(i.scenario).map(id=>({id,rewardBearing:true,passed:false}))}:f.ports.grade(i)})]});
 approval={decision:'approved',suiteDigest:artifact.digest,environmentDigest:gateDigest(artifact.environment),evidenceDigest:gateDigest(artifact.evidence),scope:artifact.scope,customerId:'owner',approvalId:'approved'};
 const {environment:_e,scenario:_s,jobId:_j,versions:_v,...trial}=trialInput('media');
 const request={artifact,versions:{...versions(),envHash:executionDigest(environment),suiteHash:freezeSandboxInputs(environment,artifact.scenarios).suiteHash},trial:{...trial,agentConfigDigest:digest,scenarioId:s.id}};
 await expect(engine.run({...request,versions:{...request.versions,spec:'unsupported' as never}})).rejects.toThrow('spec');
 await expect(engine.run({...request,trial:{...request.trial,agentConfigDigest:'changed'}})).rejects.toThrow('config');expect(dispatched).toBe(0);
 await expect(engine.run(request)).rejects.toThrow('lost acknowledgement');
 expect(events).toEqual(['allocate','capture','dispose','grade']);expect(runtime.tools).toBe(1);
 expect(reports[0].grade?.verdict).toBe('pass');expect(reports[0].media?.kind).toBe(kind);expect(reports[0].outcome.status).toBe(kind==='receipt'?'pass':'unknown');expect(reports[0].money.microUsd).toBeNull();
 // Voice's fixture tool args are {}, so spoken amount 47 fails required tool-argument perception.
 // Receipt has complete perception; neither fixture has a customer quality cost budget.
 expect(reports[0].unresolved).not.toContain('cost_unsettled');
 if(kind==='voice'){expect(reports[0].unresolved).toContain('media_perception_unresolved_or_failed');expect(reports[0].media?.artifact.perception.some(c=>!c.passed)).toBe(true);}
 const count=dispatched;await persistent.db.close();const reopened=await checkpointDatabase(join(root,'sql'));
 try{config.authority.replay=gateReplay(reopened.store);config.media!.bridge.transport=makeTransport();config.media!.bridge.authority=new FileMediaAuthority(join(root,'bridge'));
 expect(await createSandboxEngine(config).run(request)).toEqual(reports[0]);expect(dispatched).toBe(count);expect(runtime.tools).toBe(1);
 const originalApproval=approval!;approval={...originalApproval,approvalId:'replacement'};
 await expect(createSandboxEngine(config).run(request)).rejects.toThrow('identity_conflict');expect(dispatched).toBe(count);approval=originalApproval;
 const pendingInput={...runtime.input,trialId:'pending'};
 const pendingPlan=config.media!.plan(pendingInput);
 await reopened.store.claim({jobId:'sql-gates',kind:'sandbox-gate',id:'sql-job/integrated-trial/pending',inputDigest:gateDigest({input:pendingInput,suite:artifact.digest,approval,outcomeRule:reports[0].outcomeRule,policyDigest:reports[0].policyDigest,media:mediaPlanIdentity(pendingPlan)})});
 await expect(createSandboxEngine(config).run({...request,trial:{...request.trial,trialId:'pending'}})).rejects.toThrow('pending_reconciliation');expect(dispatched).toBe(count);expect(runtime.tools).toBe(1);
 stt=0;let captures=0;const priorTools=runtime.tools;
 const failedRequest={...request,trial:{...request.trial,trialId:'snapshot-failure'}};
 config.media!.captureFinalSnapshot=async()=>{captures++;throw Error('snapshot publication lost');};
 const failed=await createSandboxEngine(config).run(failedRequest);
 expect(captures).toBe(1);expect(runtime.tools).toBe(priorTools+1);
 expect(failed.execution.status).toBe('unresolved');expect(failed.grade).toBeNull();expect(failed.outcome.status).toBe('unknown');
 const afterFailure={tools:runtime.tools,dispatched};expect(await createSandboxEngine(config).run(failedRequest)).toEqual(failed);
 expect({tools:runtime.tools,dispatched}).toEqual(afterFailure);
 authorized=false;await expect(createSandboxEngine(config).run(request)).rejects.toThrow('unauthorized');expect(dispatched).toBe(afterFailure.dispatched);
 }finally{await reopened.db.close();}
 }finally{await runtime.close();await f.close();if(!persistent.db.closed)await persistent.db.close();await rm(root,{recursive:true,force:true});}
},60000);
