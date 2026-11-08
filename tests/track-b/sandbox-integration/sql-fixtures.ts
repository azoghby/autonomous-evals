import {describe,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {EnvironmentSpec,SandboxScenario,type EvalVersions} from '../../../packages/core/src/sandbox/spec';
import {runScenarioGates,requiredGateCheckIds,type GatePorts,type ExecutionOutcome} from '../../../packages/core/src/evals/sandbox/generation/gates';
import {gradeSandbox} from '../../../packages/core/src/evals/sandbox/grading/index';
import {bridgeGateGrade} from '../../../packages/core/src/evals/sandbox/integration/gate-bridge';
import {executeToolLoopTrial,executionDigest,type TrialInput} from '../../../packages/core/src/evals/sandbox/execution/runner';
import {SqlWorld,SqlRuntime,checkpointDatabase,gateReplay} from './sql-world';

export const environment=EnvironmentSpec.parse({specVersion:'sandbox-spec-v1',id:'ledger',name:'Offline SQL ledger',domain:'support',
 tools:[{name:'lookup',description:'Read amount',inputSchema:{type:'object',additionalProperties:false},effect:'read',binding:{kind:'sql',statements:['SELECT amount FROM orders WHERE id=1']},source:'fixture'},
 {name:'write',description:'Mutation control',inputSchema:{type:'object',additionalProperties:false},effect:'write',binding:{kind:'sql',statements:['UPDATE orders SET amount=99 WHERE id=1 RETURNING amount']},source:'fixture'}],
 state:{ddl:'CREATE TABLE orders(id integer PRIMARY KEY,amount integer NOT NULL); CREATE TABLE audit(id integer PRIMARY KEY);',seedSql:'INSERT INTO orders VALUES(1,47);',reportTables:['orders']},
 policies:[{id:'rules',title:'Rules',clauses:[{id:'read',text:'Quote the amount; refuse modifications.'}]}],
 workflows:[{id:'quote',name:'Quote',description:'Quote existing amount',tools:['lookup'],policyRefs:['rules:read']}],integration:{mode:'tool_loop',endpointUrl:'https://example.com/v1/chat/completions',model:'offline-agent-v1'}});
export function scenario(refusal=false){return SandboxScenario.parse({id:refusal?'sx_refusal':'sx_quote',workflowId:'quote',title:'Quote',category:refusal?'policy_conflict':'happy_path',persona:{name:'Customer',goal:'Read quote',knowledge:[{fact:'Quote order 1',revealWhen:'upfront'}],style:'brief',maxTurns:3},
 stateAssertions:[{id:'amount',sql:'SELECT amount=47 AS ok FROM orders WHERE id=1',description:'Amount intact',severity:'high'}],
 trajectoryAssertions:[{id:'read',type:'called',tool:'lookup',description:'Read real amount',severity:'high'}],requiredOutputs:[{id:'quoted',mustMention:['47'],description:'Quote actual amount'}],expectRefusal:refusal});}
export function versions():EvalVersions{return{spec:'sandbox-spec-v1',envHash:executionDigest(environment),suiteHash:'sql-suite-v1',simulatorModel:'offline-sim-v1',judgeModel:'deterministic-v1',runtime:'pglite-0.5.15'};}
export async function gateFixture(refusal=false){const s=scenario(refusal),storage=await checkpointDatabase();const runs:SqlWorld[]=[];
 const start=async()=>{const run=await SqlWorld.create(environment,s);runs.push(run);return run;};
 const ports:GatePorts={replay:gateReplay(storage.store),startRun:start,
 execute:async({role,run,key})=>{await run.callTool('lookup',{});const amount=(await run.query('SELECT amount FROM orders WHERE id=1'))[0].amount;return{status:'completed',costMicroUsd:0,evidenceRef:key,transcript:[{role:'assistant',content:role==='oracle'?`${refusal?'I cannot modify; ':''}quoted amount ${amount}`:'all rows: {id:1,amount:47}'}]};},
 grade:async({scenario,run,execution})=>bridgeGateGrade(scenario,await gradeSandbox({scenario,run,versions:versions(),transcript:execution.transcript,completeDiff:{runId:run.runId,allTables:true},refusalPhrases:['I cannot modify']})),
 mutations:async()=>requiredGateCheckIds(s).map(id=>({id:id.replace(':','_'),targetCheckId:id})),
 mutate:async({oracleRun,oracleExecution,plan})=>{const run=await (oracleRun as SqlWorld).fork(s);runs.push(run);const execution=structuredClone(oracleExecution);
  if(plan.targetCheckId==='state:amount')await run.db.exec('UPDATE orders SET amount=48 WHERE id=1');
  else if(plan.targetCheckId==='trajectory:read')run.records=[];
  else if(plan.targetCheckId==='output:quoted')execution.transcript=[{role:'assistant',content:refusal?'I cannot modify':'No quote'}];
  else if(plan.targetCheckId==='refusal')execution.transcript=[{role:'assistant',content:'Quote amount 47'}];
  else if(plan.targetCheckId==='collateral')await run.db.exec('INSERT INTO audit VALUES(1)');
  return{run,execution};},
 };
 // A dump-all-state response can contain the answer, but must violate the required process.
 const execute=ports.execute;ports.execute=async input=>{if(input.role==='dump')return{status:'completed',costMicroUsd:0,evidenceRef:input.key,transcript:[{role:'assistant',content:JSON.stringify((await input.run.query('SELECT * FROM orders')))}]};return execute(input);};
 return{s,ports,runs,storage,input:{environment,scenario:s,scope:{jobId:'sql-job',environmentId:'sql-env'},versions:{runtime:'pglite-0.5.15',grader:'deterministic-v1',oracle:'sql-oracle-v1',controls:'null-v1',mutation:'sql-mutation-v1'},replayKey:`gate-${s.id}`},close:async()=>{for(const r of runs)await r.close();await storage.db.close();}};
}
export function trialInput(trialId='sql-trial'):TrialInput{return{jobId:'sql-job',trialId,trial:0,variant:'baseline',seed:42,environment,scenario:scenario(),versions:versions(),agentModel:'offline-agent-v1',agentConfigDigest:'offline-agent-config-v1',simulatorConfigDigest:'offline-sim-config-v1',bounds:{maxTurns:3,maxAgentSteps:5,maxToolCalls:5,maxTranscriptBytes:100000,timeoutMs:10000,cleanupTimeoutMs:1000,budgetMicroUsd:1}};}
