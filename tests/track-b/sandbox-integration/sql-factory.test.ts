import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {AgentSessionService} from '../../../packages/core/src/agents/session-service';
import {PostgresAgentTaskStore,PostgresBudgetLedger} from '../../../packages/core/src/agents/postgres-ports';
import {createSandboxEngine,type PrivateSandboxReport,type SandboxEngineConfig} from '../../../packages/core/src/evals/sandbox/integration';
import {freezeSandboxInputs} from '../../../packages/core/src/evals/sandbox/identity';
import {gateDigest,type CustomerSuiteApproval} from '../../../packages/core/src/evals/sandbox/generation/gates';
import {type NaiveSessionSnapshot,type JobRef} from '../../../packages/core/src/evals/types';
import {gateFixture,environment,scenario,trialInput,versions} from './sql-fixtures';
import {SqlRuntime,SqlWorld,gateReplay,sqlPort} from './sql-world';

it('composes durable Engineer SQL generation, real gates, exact approval, retained final SQL grading and private replay',async()=>{
 const f=await gateFixture(),runtime=new SqlRuntime();let creates=0,dispatches=0,authorized=true,loseDelivery=true;
 const sessionRows=new Map<string,NaiveSessionSnapshot>(),reports=new Map<string,PrivateSandboxReport>();let approval:CustomerSuiteApproval|null=null;
 try{
 await f.storage.db.exec(await readFile(new URL('../../../packages/core/src/agents/persistence-migrations/001-agent-persistence.sql',import.meta.url),'utf8'));
 await f.storage.db.exec('CREATE TABLE operation_bindings(id text PRIMARY KEY,digest text NOT NULL); CREATE TABLE measured_costs(id text PRIMARY KEY,amount integer NOT NULL);');
 const job:JobRef={jobId:'sql-job',customerId:'offline-customer',package:'workflow_eval',environment:'test',isFixture:true,quoteVersion:null,linkedRetestOf:null};
 const createRunner=()=>new AgentSessionService({store:new PostgresAgentTaskStore(sqlPort(f.storage.db)),ledger:new PostgresBudgetLedger(sqlPort(f.storage.db)),directory:{evaluation_engineer:{agentId:'offline-engineer',agentVersion:1},commercial:{agentId:'unused'},quality_investigator:{agentId:'unused'},company_operator:{agentId:'unused'}},budgetPeriodId:'offline-period',idempotencyNamespace:'sql-integration',workerId:'worker-v1',naive:{
 createSession:async body=>{creates++;const session:NaiveSessionSnapshot={id:'offline-engineer-session',agentId:body.agent_id,agentVersion:1,status:'idle',stopReason:'end_turn',stopCode:null,structuredOutput:{scenario:scenario()},budgetMicroUsd:body.budget_micro_usd,consumedMicroUsd:7,tokenUsage:{},metadata:body.metadata};sessionRows.set(session.id,session);return session;},getSession:async id=>sessionRows.get(id)!,listAgentSessions:async()=>({data:[...sessionRows.values()],nextCursor:null})}});
 const config:SandboxEngineConfig={scope:f.input.scope,generation:{job,runner:createRunner(),sessionCapMicroUsd:100,jobCapMicroUsd:1000,
 bindOperation:async(id,digest)=>{await f.storage.db.query('INSERT INTO operation_bindings VALUES($1,$2) ON CONFLICT DO NOTHING',[id,digest]);return (await f.storage.db.query<{digest:string}>('SELECT digest FROM operation_bindings WHERE id=$1',[id])).rows[0].digest===digest?'bound':'conflict';},
 onMeasuredCost:async({taskKey,cost})=>{await f.storage.db.query('INSERT INTO measured_costs VALUES($1,$2) ON CONFLICT DO NOTHING',[taskKey,cost.microUsd]);expect((await f.storage.db.query<{amount:number}>('SELECT amount FROM measured_costs WHERE id=$1',[taskKey])).rows[0].amount).toBe(cost.microUsd);}},
 gateVersions:f.input.versions,gateEvalVersions:versions(),gates:f.ports,gateEvidence:async({run})=>({completeDiff:{runId:run.runId,allTables:true},refusalPhrases:['I cannot modify']}),approvals:{resolve:async()=>approval},
 execution:{runtime,checkpoints:f.storage.store,authorizeTrial:async()=>true,
 simulator:{model:'offline-sim-v1',configDigest:'offline-sim-config-v1',next:async({turn})=>({content:'Quote order 1',disposition:turn===0?'continue':'goal_achieved',disclosedFactIndices:[]})},
 target:()=>({model:'offline-agent-v1',configDigest:'offline-agent-config-v1',complete:async()=>{dispatches++;return{content:dispatches%2?'':'47',toolCalls:dispatches%2?[{id:`read-${dispatches}`,name:'lookup',args:{}}]:[],usage:null,money:{status:'unknown'}};}})},
 authority:{authorize:async()=>authorized,replay:gateReplay(f.storage.store),
 finalSnapshot:async artifact=>{const original=runtime.runs.find(r=>r.runId===artifact.runId)!;const snapshot=runtime.snapshots.get(original.runId)!;
 // A private independent final database is available only through read-only grading methods.
 const run={runId:original.runId,query:snapshot.query.bind(snapshot),diff:snapshot.diff.bind(snapshot),trajectory:snapshot.trajectory.bind(snapshot)};
 await original.db.exec('UPDATE orders SET amount=9 WHERE id=1');
 return{run,evidence:{completeDiff:{runId:original.runId,allTables:true}},release:async()=>{await snapshot.close();snapshot.disposed=true;}};},
 persistPrivateReport:async report=>{const key=report.execution.identityDigest,prior=reports.get(key);if(prior)expect(report).toEqual(prior);reports.set(key,structuredClone(report));if(loseDelivery){loseDelivery=false;throw Error('lost durable report acknowledgement');}}}};
 const engine=createSandboxEngine(config),request={operationKey:'engineer-v1',environment,slots:[{id:'quote_slot',workflowId:'quote',category:'happy_path' as const,expectRefusal:false,policyRefs:[{docId:'rules',clauseId:'read'}]}]};
 const generated=await engine.generate(request);expect(generated.status).toBe('complete');expect(generated.artifact,JSON.stringify(generated)).not.toBeNull();expect(creates).toBe(1);expect(generated.candidates[0].scenario.oracleValidated).toBe(false);expect(generated.costs[0].microUsd).toBe(7);
 config.generation.runner=createRunner();const replay=await createSandboxEngine(config).generate(request);expect(replay.artifact).toEqual(generated.artifact);expect(creates).toBe(1);
 const proposal=await engine.propose({environment,scenarios:[scenario()],operationKey:'proposal-v1'});expect(proposal.scenarios).toHaveLength(1);await expect(engine.propose({environment:{...environment,name:'changed'},scenarios:[scenario()],operationKey:'proposal-v1'})).rejects.toThrow('identity_conflict');
 const artifact=generated.artifact!,frozen=freezeSandboxInputs(environment,artifact.scenarios);const {environment:_env,scenario:_scenario,versions:_versions,jobId:_job,...trial}=trialInput('factory-trial');const input={artifact,versions:{...versions(),suiteHash:frozen.suiteHash},trial:{...trial,scenarioId:artifact.scenarios[0].id}};
 await expect(engine.run(input)).rejects.toThrow('Customer approval');expect(dispatches).toBe(0);
 approval={decision:'approved',suiteDigest:artifact.digest,environmentDigest:gateDigest(artifact.environment),evidenceDigest:gateDigest(artifact.evidence),scope:artifact.scope,customerId:'offline-customer',approvalId:'approval-v1'};
 await expect(engine.run({...input,versions:{...input.versions,runtime:'changed'}})).rejects.toThrow('version');expect(dispatches).toBe(0);await expect(createSandboxEngine({...config,gateVersions:{...config.gateVersions,mutation:'changed'}}).run(input)).rejects.toThrow('gate_version');expect(dispatches).toBe(0);
 await expect(engine.run(input)).rejects.toThrow('lost durable report acknowledgement');expect(dispatches).toBe(2);const report=await createSandboxEngine(config).run(input);expect(dispatches).toBe(2);expect(report.grade?.verdict).toBe('pass');expect(report.outcome.status).toBe('unknown');expect(report.money).toEqual({status:'unknown',microUsd:null});expect(report.unresolved).toContain('cost_unsettled');expect(reports.size).toBe(1);
 expect(engine.summarize([report],2)).toMatchObject({expected:2,observed:1,missing:1,eligible:0,passed:0,passRate:null,ci95:null,allK:null,excluded:{unknown:1}});
 authorized=false;await expect(engine.run(input)).rejects.toThrow('unauthorized');expect(dispatches).toBe(2);
 }finally{await runtime.close();await f.close();}
},60000);
