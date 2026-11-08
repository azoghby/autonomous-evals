import {it,expect} from 'vitest';
import {createSandboxEngine,type SandboxEngineConfig} from '../../../packages/core/src/evals/sandbox/integration';
import {freezeSandboxInputs} from '../../../packages/core/src/evals/sandbox/identity';
import {gateDigest,type CustomerSuiteApproval} from '../../../packages/core/src/evals/sandbox/generation/gates';
import {gateFixture,environment,scenario,trialInput,versions} from '../sandbox-integration/sql-fixtures';
import {SqlRuntime,SqlWorld,gateReplay} from '../sandbox-integration/sql-world';

it('acceptance and trust characterization: cross-world SQL snapshot rejected by honest identity; relabeling requires privileged authority',async()=>{
 const f=await gateFixture(),runtime=new SqlRuntime(),alien=await SqlWorld.create(environment,scenario());
 let approval:CustomerSuiteApproval|null=null,spoof=false,dispatches=0,releases=0;
 try{
 await alien.db.exec('UPDATE orders SET amount=9 WHERE id=1');
 const config:SandboxEngineConfig={scope:f.input.scope,gateVersions:f.input.versions,gateEvalVersions:versions(),gates:f.ports,
 generation:{job:{jobId:'sql-job',customerId:'offline-customer',package:'workflow_eval',environment:'test',isFixture:true,quoteVersion:null,linkedRetestOf:null},runner:{run:async()=>{throw Error('unused');}},sessionCapMicroUsd:1,jobCapMicroUsd:1,bindOperation:async()=> 'bound',onMeasuredCost:async()=>{}},
 gateEvidence:async({run})=>({completeDiff:{runId:run.runId,allTables:true}}),approvals:{resolve:async()=>approval},
 execution:{runtime,checkpoints:f.storage.store,authorizeTrial:async()=>true,
 simulator:{model:'offline-sim-v1',configDigest:'offline-sim-config-v1',next:async({turn})=>({content:'Quote order 1',disposition:turn===0?'continue':'goal_achieved',disclosedFactIndices:[]})},
 target:()=>({model:'offline-agent-v1',configDigest:'offline-agent-config-v1',complete:async()=>{dispatches++;return{content:dispatches%2?'':'47',toolCalls:dispatches%2?[{id:`read-${dispatches}`,name:'lookup',args:{}}]:[],usage:null,money:{status:'unknown'}};}})},
 authority:{authorize:async()=>true,replay:gateReplay(f.storage.store),persistPrivateReport:async()=>{},finalSnapshot:async artifact=>({
 run:{runId:spoof?artifact.runId!:alien.runId,query:alien.query.bind(alien),diff:async()=>structuredClone(artifact.diff!),trajectory:()=>structuredClone(artifact.toolCalls)},
 evidence:{completeDiff:{runId:artifact.runId!,allTables:true}},release:async()=>{releases++;}})}};
 const engine=createSandboxEngine(config);const artifact=await engine.propose({environment,scenarios:[scenario()],operationKey:'snapshot-review'});
 approval={decision:'approved',suiteDigest:artifact.digest,environmentDigest:gateDigest(artifact.environment),evidenceDigest:gateDigest(artifact.evidence),scope:artifact.scope,customerId:'offline-customer',approvalId:'review-approval'};
 const request=(id:string)=>{const {environment:_e,scenario:_s,versions:_v,jobId:_j,...trial}=trialInput(id);return{artifact,versions:{...versions(),suiteHash:freezeSandboxInputs(environment,artifact.scenarios).suiteHash},trial:{...trial,scenarioId:scenario().id}};};
 const rejected=await engine.run(request('honest-alien-id'));expect(rejected.grade).toBeNull();expect(rejected.unresolved).toContain('final_snapshot_unavailable');
 spoof=true;const trusted=await engine.run(request('privileged-relabel'));
 expect(trusted.grade?.checks.find(c=>c.id==='state:amount')?.verdict).toBe('fail');
 expect(trusted.unresolved).not.toContain('snapshot_execution_mismatch');expect(trusted.outcome.status).toBe('unknown');expect(releases).toBe(2);
 // Deliberately dishonest finalSnapshot supplies an alien SQL reader plus copied diff/trajectory.
 // This characterizes the server authority trust boundary, not customer-controlled snapshot selection.
 }finally{await alien.close();await runtime.close();await f.close();}
},60000);
