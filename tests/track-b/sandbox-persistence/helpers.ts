import {createRequire} from 'node:module';
import {EnvironmentSpec,SandboxScenario} from '../../../packages/core/src/sandbox/spec';
import {executionDigest,type TrialInput,type TrialArtifact} from '../../../packages/core/src/evals/sandbox/execution/runner';
import type {PrivateSandboxReport} from '../../../packages/core/src/evals/sandbox/integration';
import type {AgentTransactionalSql,AgentSqlExecutor} from '../../../packages/core/src/agents/postgres-ports';
import {createPostgresSandboxPersistence} from '../../../packages/core/src/evals/sandbox/persistence';
const require=createRequire(`${process.env.SANDBOX_PERSISTENCE_RUNTIME}/package.json`);
const {Pool}=require('pg');
export const scope={tenantId:'tenant-a',jobId:'job-a',environmentId:'env_a'};
export function connection(){
 const pool=new Pool({...JSON.parse(process.env.SANDBOX_PERSISTENCE_CONFIG!),max:2});
 const db:AgentTransactionalSql={query:(sql,params)=>pool.query(sql,params),transaction:async fn=>{
  const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');const value=await fn({query:(sql,params)=>c.query(sql,params)} as AgentSqlExecutor);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }};
 return {db,pool,close:()=>pool.end()};
}
export function persistence(db:AgentTransactionalSql,overrides:Partial<Parameters<typeof createPostgresSandboxPersistence>[0]>={}){
 return createPostgresSandboxPersistence({db,scope,authorize:async()=>true,...overrides});
}
export const digest=(s:string)=>executionDigest(s);
export function report(trialId='trial-1'):PrivateSandboxReport{
 const environment=EnvironmentSpec.parse({specVersion:'sandbox-spec-v1',id:'env_a',name:'Acme',domain:'support',tools:[{name:'lookup',description:'lookup',inputSchema:{type:'object'},effect:'read',binding:{kind:'sql',statements:['SELECT 1']},source:'test'}],state:{ddl:'CREATE TABLE x(id int)',seedSql:''},workflows:[{id:'support',name:'support',description:'support',tools:['lookup']}],integration:{mode:'tool_loop',endpointUrl:'https://example.com/v1/chat/completions',model:'agent/pinned'}});
 const scenario=SandboxScenario.parse({id:'sx_quote',workflowId:'support',title:'Quote',category:'happy_path',persona:{name:'user',goal:'quote',knowledge:[],style:''}});
 const input:TrialInput={jobId:scope.jobId,trialId,trial:0,variant:'base',seed:7,environment,scenario,versions:{spec:'sandbox-spec-v1',envHash:executionDigest(environment),suiteHash:digest('suite'),simulatorModel:'sim/pinned',judgeModel:'judge/pinned',runtime:'runtime-v1'},agentModel:'agent/pinned',agentConfigDigest:digest('agent'),simulatorConfigDigest:digest('simulator'),bounds:{maxTurns:1,maxAgentSteps:4,maxToolCalls:4,maxTranscriptBytes:100000,timeoutMs:300,cleanupTimeoutMs:50,budgetMicroUsd:1000}};
 const execution:TrialArtifact={schema:'sandbox-execution-v1',identityDigest:executionDigest(input),input,status:'unresolved',reason:'pending_reconciliation',runId:null,worldId:null,transcript:[],toolCalls:[],diff:null,outbox:null,cleanup:{run:'not_created',world:'not_created'},grading:'not_run',money:{status:'unknown',microUsd:null},infrastructure:'unknown',elapsedMs:0};
 return {schema:'sandbox-private-report-v1',suiteDigest:digest('approved-suite'),approvalId:'approval-a',execution,grade:null,outcome:{scenarioId:scenario.id,trial:input.trial,seed:String(input.seed),fixtureHash:digest('fixture'),variant:input.variant,agentVersion:digest('agent-version'),versions:input.versions,status:'unknown',failureAttribution:'unknown'},unresolved:['cost_unsettled'],money:execution.money};
}
