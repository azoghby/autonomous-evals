import {describe,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {EnvironmentSpec,SandboxScenario,type EvalVersions} from '../../../packages/core/src/sandbox/spec';
import {runScenarioGates,requiredGateCheckIds,type GatePorts,type ExecutionOutcome} from '../../../packages/core/src/evals/sandbox/generation/gates';
import {gradeSandbox} from '../../../packages/core/src/evals/sandbox/grading/index';
import {bridgeGateGrade} from '../../../packages/core/src/evals/sandbox/integration/gate-bridge';
import {executeToolLoopTrial,executionDigest,type TrialInput} from '../../../packages/core/src/evals/sandbox/execution/runner';
import {SqlWorld,SqlRuntime,checkpointDatabase,gateReplay} from './sql-world';

import { environment, scenario, versions, gateFixture, trialInput } from './sql-fixtures';
describe('actual PostgreSQL oracle, controls and mutations',()=>{
 for(const refusal of [false,true])it(`admits honest ${refusal?'refusal':'read-only'} oracle and flips each reward target`,async()=>{const f=await gateFixture(refusal);try{const e=await runScenarioGates(f.input,f.ports);expect(e.status,e.reasons.join(',')).toBe('passed');expect(e.runs.map(r=>r.grade.checks.filter(c=>c.rewardBearing).every(c=>c.passed))).toEqual([true,false,false,false]);expect(e.mutations).toHaveLength(requiredGateCheckIds(f.s).length);expect(new Set(f.runs.map(r=>r.runId)).size).toBe(f.runs.length);expect(f.runs.every(r=>r.disposed)).toBe(true);expect((await f.runs[0].query('SELECT amount FROM orders WHERE id=1'))[0].amount).toBe(47);const n=f.runs.length;expect(await runScenarioGates(f.input,f.ports)).toEqual(e);expect(f.runs).toHaveLength(n);}finally{await f.close();}},30000);
 it('does not admit allowed-table writes or unknown measured gate cost',async()=>{const f=await gateFixture();try{const run=await SqlWorld.create(environment,f.s);f.runs.push(run);await run.callTool('lookup',{});await run.callTool('write',{});const s=SandboxScenario.parse({...f.s,allowedWriteTables:['orders'],allowedChanges:[{table:'orders',description:'Only row 1'}],stateAssertions:[]});const grade=await gradeSandbox({scenario:s,run,versions:versions(),transcript:[{role:'assistant',content:'47'}],completeDiff:{runId:run.runId,allTables:true}});expect(grade.verdict).toBe('unknown');expect(bridgeGateGrade(s,grade).complete).toBe(false);
 const exec=f.ports.execute;f.ports.execute=async x=>({...await exec(x),costMicroUsd:null});expect((await runScenarioGates(f.input,f.ports)).status).toBe('unresolved');}finally{await f.close();}},30000);
 it('PostgreSQL enforces read-only grader SQL and all-table collateral sees nonreport tables',async()=>{const f=await gateFixture();try{const r=await SqlWorld.create(environment,f.s);f.runs.push(r);await expect(r.query('DELETE FROM orders RETURNING *')).rejects.toThrow();expect((await r.query('SELECT count(*)::int AS n FROM orders'))[0].n).toBe(1);await r.db.exec('INSERT INTO audit VALUES(1)');expect(await r.diff()).toEqual([{table:'audit',inserted:1,deleted:0,updated:0,sample:[{id:1}]}]);}finally{await f.close();}},30000);
});

describe('tool loop with durable SQL checkpoints',()=>{
 it('reopens SQL after restart without duplicate dispatch; independent trials have actual isolated SQL state',async()=>{
 const path=await mkdtemp(join(tmpdir(),'sandbox-integration-sql-')),runtime=new SqlRuntime();let db:Awaited<ReturnType<typeof checkpointDatabase>>|undefined;
 try{db=await checkpointDatabase(join(path,'checkpoints'));let dispatch=0;const ports={runtime,checkpoints:db.store,authorizeTrial:async()=>true,
 simulator:{model:'offline-sim-v1',configDigest:'offline-sim-config-v1',next:async({turn}:{turn:number})=>({content:'Quote order 1',disposition:turn===0?'continue' as const:'goal_achieved' as const,disclosedFactIndices:[]})},
 target:()=>({model:'offline-agent-v1',configDigest:'offline-agent-config-v1',complete:async()=>{dispatch++;return{content:dispatch%2===1?'':'47',toolCalls:dispatch%2===1?[{id:`lookup-${dispatch}`,name:'lookup',args:{}}]:[],usage:null,money:{status:'unknown' as const}};}})};
 const input=trialInput(),a=await executeToolLoopTrial(input,ports);expect(a.status).toBe('completed');expect(a.money).toEqual({status:'unknown',microUsd:null});expect(a.cleanup).toEqual({run:'succeeded',world:'succeeded'});expect(a.input.seed).toBe(42);const grade=await gradeSandbox({scenario:input.scenario,versions:input.versions,run:runtime.runs[0],transcript:a.transcript,completeDiff:{runId:a.runId!,allTables:true}});expect(grade.verdict).toBe('pass');
 await db.db.close();db=await checkpointDatabase(join(path,'checkpoints'));ports.checkpoints=db.store;expect(await executeToolLoopTrial(input,ports)).toEqual(a);expect(dispatch).toBe(2);
 const b=await executeToolLoopTrial({...input,trialId:'sql-trial-2',trial:1,seed:43},ports);expect(b.runId).not.toBe(a.runId);await runtime.runs[0].db.exec('UPDATE orders SET amount=9');expect((await runtime.runs[1].query('SELECT amount FROM orders WHERE id=1'))[0].amount).toBe(47);
 const pending=trialInput('pending');await db.store.claim({jobId:pending.jobId,kind:'sandbox_execution_trial_v1',id:pending.trialId,inputDigest:executionDigest(pending)});const calls=dispatch;expect((await executeToolLoopTrial(pending,ports)).reason).toBe('pending_reconciliation');expect(dispatch).toBe(calls);
 }finally{await runtime.close();if(db)await db.db.close();await rm(path,{recursive:true,force:true});}
 },30000);
});
