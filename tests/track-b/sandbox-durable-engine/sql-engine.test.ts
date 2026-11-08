import { mediaPlanIdentity } from '../../../packages/core/src/evals/sandbox/integration/media';
import { ActualMediaRuntime } from '../sandbox-media-integration/actual-runtime';
import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type SandboxEngineConfig, type PrivateSandboxReport } from '../../../packages/core/src/evals/sandbox/integration';
import { createReceiptChatTarget } from '../../../packages/core/src/evals/sandbox/multimodal/vision';
import { FileMediaAuthority, createMediaTransport } from '../../../packages/core/src/evals/sandbox/multimodal/common';
import { executionDigest } from '../../../packages/core/src/evals/sandbox/execution/runner';
import { gradeSandbox } from '../../../packages/core/src/evals/sandbox/grading';
import { bridgeGateGrade } from '../../../packages/core/src/evals/sandbox/integration/gate-bridge';
import { freezeSandboxInputs } from '../../../packages/core/src/evals/sandbox/identity';
import { createSuiteGateArtifact, runScenarioGates, gateDigest, requiredGateCheckIds, type CustomerSuiteApproval } from '../../../packages/core/src/evals/sandbox/generation/gates';
import { gateFixture, environment, trialInput, versions } from '../sandbox-integration/sql-fixtures';
import { SqlWorld, SqlRuntime, checkpointDatabase, sqlPort } from '../sandbox-integration/sql-world';

import { validatePrivateReport } from '../../../packages/core/src/evals/sandbox/persistence/schema';
import { createDurableSandboxEngine, createPostgresSandboxPersistence, privateSandboxReportDigest } from '../../../packages/core/src/evals/sandbox/persistence';

const wav = () => { const b = Buffer.alloc(48); b.write('RIFF'); b.write('WAVE',8); return b.toString('base64'); };
for (const kind of ['receipt','voice'] as const) it(`${kind}: admitted SQL lifecycle, pre-disposal snapshot, private delivery and durable restart`, async () => {
 const root = await mkdtemp(join(tmpdir(),'engine-media-')), f = await gateFixture();
 let dispatched=0, stt=0, authorized=true, approval: CustomerSuiteApproval | null=null;
 const events:string[]=[];const runtime=new ActualMediaRuntime(events);
 const persistent=await checkpointDatabase(join(root,'sql'));
 try {
 const environment=structuredClone(f.input.environment);
 f.input.scope.environmentId=environment.id;
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
 const config:Omit<SandboxEngineConfig,'authority'> & {authority: Omit<SandboxEngineConfig['authority'],'replay'|'persistPrivateReport'>}={scope:f.input.scope,generation:{job:{jobId:'sql-job',customerId:'owner',package:'workflow_eval',environment:'test',isFixture:true,quoteVersion:null,linkedRetestOf:null},runner:{} as never,sessionCapMicroUsd:1,jobCapMicroUsd:1,bindOperation:async()=> 'bound',onMeasuredCost:async()=>{}},gateVersions:f.input.versions,gateEvalVersions:versions(),gates:f.ports,gateEvidence:async({run})=>({completeDiff:{runId:run.runId,allTables:true}}),approvals:{resolve:async()=>approval},execution:{runtime,checkpoints:persistent.store,authorizeTrial:async()=>true,simulator:{model:'offline-sim-v1',configDigest:'offline-sim-config-v1',next:async()=>{throw Error('media must not call text simulator');}},target:()=>{throw Error('media must not call text target');}},
 media:{plan:input=>{runtime.input=structuredClone(input);return kind==='receipt'?{kind,input:{attachment:s.attachments[0],oracleModel:'independent-oracle',targetModel:target.model,seed:42,maxBytes:2000000},target}:{kind,input:{text:'Quote 47',facts:{amount:'47'},voice:s.persona.voice!,sttModel:'independent-stt',target:voiceTarget,maxAudioBytes:10000,maxToolRounds:2,maxToolCalls:2,maxElapsedMs:5000,maxInputWer:0}};},bridge:{authority:new FileMediaAuthority(join(root,'bridge')),authorize:async()=>{},transport,secrets:['offline-credential'],maxArtifactBytes:100000,timeoutMs:5000},captureFinalSnapshot:async({run,execution})=>{expect(runtime.disposed.has(run.runId)).toBe(false);events.push('capture');await runtime.handles.get(run.runId)!.seal();expect(execution.runId).toBe(run.runId);}},
 authority:{authorize:async()=>authorized,finalSnapshot:async a=>{events.push('grade');expect(runtime.disposed.has(a.runId!)).toBe(true);const snapshot=await runtime.handles.get(a.runId!)!.finalSnapshot(a);return{...snapshot,evidence:{...snapshot.evidence,perception:kind==='receipt'?[{attachmentId:'receipt',field:'total',toolSeq:1,argumentPath:['total']}]:[]}};}}};
 const scope={tenantId:'owner',...f.input.scope};
 const persistenceConfig={scope,db:sqlPort(persistent.db),authorize:async()=>authorized,knownSecrets:['offline-credential']};
 const engine=createDurableSandboxEngine(config,persistenceConfig);
 // Use the actual media grader for proposal as well.
 config.gateEvidence=async({run})=>({completeDiff:{runId:run.runId,allTables:true},perception:kind==='receipt'?[{attachmentId:'receipt',field:'total',toolSeq:1,argumentPath:['total']}]:[]});
 // Receipt admission is a trusted protocol fixture: current deterministic perception
 // treats absent null-control arguments as unknown, so it cannot admit that suite.
 // The local engine lifecycle below still uses the actual deterministic SQL grader.
 const gateInput={...f.input,environment,scenario:s,replayKey:'receipt-admission-fixture'};
 const artifact=kind==='voice'?await engine.propose({environment,scenarios:[s],operationKey:'media-suite'}):createSuiteGateArtifact({scope:f.input.scope,environment,scenarios:[s],evidence:[await runScenarioGates(gateInput,{...f.ports,grade:async i=> /\/(do_nothing|empty|dump)$/.test(i.execution.evidenceRef ?? '')?{complete:true,checks:requiredGateCheckIds(i.scenario).map(id=>({id,rewardBearing:true,passed:false}))}:f.ports.grade(i)})]});
 approval={decision:'approved',suiteDigest:artifact.digest,environmentDigest:gateDigest(artifact.environment),evidenceDigest:gateDigest(artifact.evidence),scope:artifact.scope,customerId:'owner',approvalId:'approved'};
 const {environment:_e,scenario:_s,jobId:_j,versions:_v,...trial}=trialInput('media');
 const request={artifact,versions:{...versions(),envHash:executionDigest(environment),suiteHash:freezeSandboxInputs(environment,artifact.scenarios).suiteHash},trial:{...trial,bounds:{...trial.bounds,timeoutMs:60000,cleanupTimeoutMs:10000},agentConfigDigest:digest,scenarioId:s.id}};
 await expect(engine.run({...request,versions:{...request.versions,spec:'unsupported' as never}})).rejects.toThrow('spec');
 await expect(engine.run({...request,trial:{...request.trial,agentConfigDigest:'changed'}})).rejects.toThrow('config');expect(dispatched).toBe(0);
 const report=await engine.run(request);
 expect(events).toEqual(['allocate','capture','dispose','grade']);expect(runtime.tools).toBe(1);
 expect(report.grade?.verdict,JSON.stringify({execution:report.execution,unresolved:report.unresolved})).toBe('pass');expect(report.media?.kind).toBe(kind);
 // Receipt quality is fully proven without a customer cost gate. Voice still
 // lacks passing tool-argument perception; neither invents settled money.
 expect(report.outcome.status).toBe(kind==='receipt'?'pass':'unknown');expect(report.money.microUsd).toBeNull();
 expect(report.outcomeRule).toBe('sandbox-quality-outcome-v2');
 expect(report.qualityCostPolicy).toBeNull();
 expect(report.policyDigest).toBe(gateDigest({outcomeRule:report.outcomeRule,qualityCostPolicy:null}));
 expect(await engine.readPrivateReport(request.trial.trialId,report.execution.identityDigest)).toEqual(report);
 assertMediaCorruptionRejected(report);
 const bytes=privateSandboxReportDigest(report),count=dispatched;
 config.authority.finalSnapshot=async()=>{throw Error('restart must not regrade');};
 config.media!.captureFinalSnapshot=async()=>{throw Error('restart must not capture');};
 config.execution.runtime={prepare:async()=>{throw Error('restart must not prepare');},startRun:async()=>{throw Error('restart must not allocate');},teardown:async()=>{throw Error('restart must not teardown');}};
 await persistent.db.close();const reopened=await checkpointDatabase(join(root,'sql'));
 try{
 const restarted=createDurableSandboxEngine(config,{...persistenceConfig,db:sqlPort(reopened.db)});
 expect(privateSandboxReportDigest((await restarted.readPrivateReport(request.trial.trialId,report.execution.identityDigest))!)).toBe(bytes);
 expect(await restarted.run(request)).toEqual(report);expect(dispatched).toBe(count);expect(runtime.tools).toBe(1);
 await expect(restarted.readPrivateReport(request.trial.trialId,executionDigest('wrong'))).rejects.toThrow('identity_conflict');
 const originalApproval=approval!;approval={...originalApproval,approvalId:'replacement'};
 await expect(restarted.run(request)).rejects.toThrow('identity_conflict');expect(dispatched).toBe(count);approval=originalApproval;
 const foreign=createPostgresSandboxPersistence({...persistenceConfig,scope:{...scope,tenantId:'other-tenant'},db:sqlPort(reopened.db)});
 expect(await foreign.readPrivateReport(request.trial.trialId)).toBeNull();
 authorized=false;await expect(restarted.run(request)).rejects.toThrow('unauthorized');
 await expect(restarted.readPrivateReport(request.trial.trialId)).rejects.toThrow('unauthorized');expect(dispatched).toBe(count);
 }finally{await reopened.db.close();}
 }finally{await runtime.close();await f.close();if(!persistent.db.closed)await persistent.db.close();await rm(root,{recursive:true,force:true});}
},60000);

it('actual text engine persists exact report bytes and resumes from reopened SQL without target dispatch',async()=>{
 const root=await mkdtemp(join(tmpdir(),'durable-text-')),f=await gateFixture(),runtime=new SqlRuntime();
 let storage=await checkpointDatabase(join(root,'sql')),dispatches=0,authorized=true;
 let approval:CustomerSuiteApproval|null=null;
 try {
 f.input.scope.environmentId=f.input.environment.id;
 const config:Omit<SandboxEngineConfig,'authority'> & {authority:Omit<SandboxEngineConfig['authority'],'replay'|'persistPrivateReport'>}={
 scope:f.input.scope,generation:{job:{jobId:'sql-job',customerId:'owner',package:'workflow_eval',environment:'test',isFixture:true,quoteVersion:null,linkedRetestOf:null},runner:{} as never,sessionCapMicroUsd:1,jobCapMicroUsd:1,bindOperation:async()=> 'bound',onMeasuredCost:async()=>{}},
 gateVersions:f.input.versions,gateEvalVersions:versions(),gates:f.ports,
 gateEvidence:async({run})=>({completeDiff:{runId:run.runId,allTables:true}}),approvals:{resolve:async()=>approval},
 execution:{runtime,checkpoints:storage.store,authorizeTrial:async()=>true,
 simulator:{model:'offline-sim-v1',configDigest:'offline-sim-config-v1',next:async({turn})=>({content:'Quote order 1',disposition:turn===0?'continue':'goal_achieved',disclosedFactIndices:[]})},
 target:()=>({model:'offline-agent-v1',configDigest:'offline-agent-config-v1',complete:async()=>{
 dispatches++;return{content:dispatches%2?'':'47',toolCalls:dispatches%2?[{id:'read',name:'lookup',args:{}}]:[],usage:null,money:{status:'unknown'}};
 }})},
 authority:{authorize:async()=>authorized,finalSnapshot:async artifact=>{
 const snapshot=runtime.snapshots.get(artifact.runId!)!;
 return{run:{runId:artifact.runId!,query:snapshot.query.bind(snapshot),diff:snapshot.diff.bind(snapshot),trajectory:snapshot.trajectory.bind(snapshot)},evidence:{completeDiff:{runId:artifact.runId!,allTables:true}},release:async()=>{await snapshot.close();snapshot.disposed=true;}};
 }}};
 const persistenceConfig={scope:{tenantId:'owner',...f.input.scope},db:sqlPort(storage.db),authorize:async()=>authorized};
 const engine=createDurableSandboxEngine(config,persistenceConfig);
 const artifact=await engine.propose({environment:f.input.environment,scenarios:[f.s],operationKey:'durable-text'});
 approval={decision:'approved',suiteDigest:artifact.digest,environmentDigest:gateDigest(artifact.environment),evidenceDigest:gateDigest(artifact.evidence),scope:artifact.scope,customerId:'owner',approvalId:'approved'};
 const {environment:_e,scenario:_s,jobId:_j,versions:_v,...trial}=trialInput('durable-text');
 const request={artifact,versions:{...versions(),suiteHash:freezeSandboxInputs(artifact.environment,artifact.scenarios).suiteHash},trial:{...trial,bounds:{...trial.bounds,timeoutMs:60000,cleanupTimeoutMs:10000},scenarioId:f.s.id}};
 const report=await engine.run(request);expect(report.grade?.verdict,JSON.stringify({execution:report.execution,unresolved:report.unresolved})).toBe('pass');expect(dispatches).toBe(2);
 expect(Object.hasOwn(report,'media')).toBe(false);
 expect(await engine.readPrivateReport(trial.trialId,report.execution.identityDigest)).toEqual(report);
 const bytes=privateSandboxReportDigest(report);
 config.authority.finalSnapshot=async()=>{throw Error('restart must not regrade');};
 config.execution.runtime={prepare:async()=>{throw Error('restart must not prepare');},startRun:async()=>{throw Error('restart must not allocate');},teardown:async()=>{throw Error('restart must not teardown');}};
 config.execution.target=()=>{throw Error('restart must not dispatch');};
 await storage.db.close();storage=await checkpointDatabase(join(root,'sql'));
 config.execution.checkpoints=storage.store;
 const restarted=createDurableSandboxEngine(config,{...persistenceConfig,db:sqlPort(storage.db)});
 expect(privateSandboxReportDigest((await restarted.readPrivateReport(trial.trialId))!)).toBe(bytes);
 expect(await restarted.run(request)).toEqual(report);expect(dispatches).toBe(2);expect(runtime.runs).toHaveLength(1);
 authorized=false;await expect(restarted.readPrivateReport(trial.trialId)).rejects.toThrow('unauthorized');
 }finally{await runtime.close();await f.close();if(!storage.db.closed)await storage.db.close();await rm(root,{recursive:true,force:true});}
},60000);

function assertMediaCorruptionRejected(report:PrivateSandboxReport){
 const reject=(change:(value:PrivateSandboxReport)=>void)=>{
 const value=structuredClone(report);change(value);
 expect(()=>validatePrivateReport(value,report.execution.input.jobId)).toThrow(/sandbox_persistence/);
 };
 reject(r=>{(r.media as unknown as Record<string,unknown>).unexpected={accepted:true};});
 reject(r=>{(r.media!.artifact as unknown as Record<string,unknown>).unexpected={accepted:true};});
 reject(r=>{r.execution.identityDigest=executionDigest('wrong-execution');});
 reject(r=>{r.outcome.fixtureHash=executionDigest('wrong-fixture');});
 reject(r=>{r.outcome.agentVersion=executionDigest('wrong-agent');});
 reject(r=>{r.execution.toolCalls[0].args={corrupt:true};});
 reject(r=>{r.execution.transcript[0].content='corrupt';});
 if(report.media?.kind==='receipt'){
 reject(r=>{if(r.media?.kind==='receipt')r.media.artifact.provenance.targetConfigDigest=executionDigest('wrong-config');});
 reject(r=>{if(r.media?.kind==='receipt')r.media.artifact.provenance.assetSha256=executionDigest('wrong-image');});
 reject(r=>{if(r.media?.kind==='receipt')r.media.artifact.target.model='wrong-model';});
 reject(r=>{if(r.media?.kind==='receipt')r.media.artifact.provenance.oracleOperationId='wrong-operation';});
 reject(r=>{if(r.media?.kind==='receipt')r.media.artifact.oracle.fields[0].read='999';});
 reject(r=>{if(r.media?.kind==='receipt')r.media.artifact.oracle.fields[0].expected='999';});
 reject(r=>{if(r.media?.kind==='receipt')r.media.artifact.target.transcript[0].content='corrupt';});
 reject(r=>{if(r.media?.kind==='receipt')r.media.artifact.target.toolCalls[0].result={corrupt:true};});
 reject(r=>{if(r.media?.kind==='receipt')r.media.artifact.perception[0].passed=false;});
 }else if(report.media?.kind==='voice'){
 reject(r=>{if(r.media?.kind==='voice')r.media.artifact.oracle.assetSha256=executionDigest('wrong-audio');});
 reject(r=>{if(r.media?.kind==='voice')r.media.artifact.models.tts='wrong-tts';});
 reject(r=>{if(r.media?.kind==='voice')r.media.artifact.oracle.model='wrong-stt';});
 reject(r=>{if(r.media?.kind==='voice')r.media.artifact.models.target='wrong-target';});
 reject(r=>{if(r.media?.kind==='voice')r.media.artifact.reply='corrupt';});
 reject(r=>{if(r.media?.kind==='voice')r.media.artifact.toolCalls[0].seq=99;});
 }
}
