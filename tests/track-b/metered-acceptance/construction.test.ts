// Actual rich factory, fixture-only SQL/canonical/bootstrap authorities. No secret resolver.
import {it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({runtime:undefined as any,bootstrap:vi.fn(async()=>({runner:{run:async()=>{throw Error('unexpected_session');}}}))}));
vi.mock('@neondatabase/serverless',()=>({Pool:class {
 async query(sql:string){
  if(sql.includes('workflow_integration.bindings'))return {rows:[{target_revision:'fixture-v1',reviewed_calendar:null,isolation:'request_messages_only',remediation_operation_micro_usd:1,baseline_suite_digest:null,baseline_run_id:null}]};
  if(sql.includes('is_internal_fixture'))return {rows:[{fixture:true}]};
  if(sql.includes('ciphertext'))return {rows:[{ciphertext:'fixture-encrypted'}]};
  throw Error('unexpected_sql');
 }
}}));
vi.mock('@/server/job-store',()=>({getJobWithDecryptedCredentials:async()=>({job:{id:'fixture',customerId:'tenant',workflowRunId:'workflow',environment:'test',isMock:false,state:'running'},credentials:{},intake:{package:'text_eval',authorizedToTest:true,endpoint:{url:'https://fixture.invalid/chat/completions',model:'fixture',systemPrompt:'fixture'}}}),recordCost:vi.fn()}));
vi.mock('@ae/core/integration/eval-services',()=>({buildAgentDeps:state.bootstrap,evalServices:{}}));
vi.mock('@/server/rich-judge',async importOriginal=>{
 const actual=await importOriginal<any>();
 return {...actual,workflowJudgeRuntime:vi.fn(()=>{state.runtime=actual.workflowJudgeRuntime();return state.runtime;})};
});
import {createRichWorkflowServices} from '@/server/rich-services';
import {workflowJudgeRuntime} from '@/server/rich-judge';
it('actual default rich construction selects actual production runtime, with the16/24 gap preserved',async()=>{
 for(const [k,v] of Object.entries({DATABASE_URL:'postgres://fixture.invalid/offline',WORKFLOW_JUDGE_AUTH:'api_key',WORKFLOW_JUDGE_MODEL:'fixture/model',WORKFLOW_JUDGE_CONFIG_VERSION:'fixture-v1',WORKFLOW_JUDGE_RESERVATION_MICRO_USD:'1',NAIVE_BUDGET_PERIOD_ID:'fixture'}))vi.stubEnv(k,v);
 try{
 const api=await createRichWorkflowServices({jobId:'fixture',environment:'test',budgetMicroUsd:100000,recordCost:async()=>{},recordProgress:async()=>{}},{workflowRunId:'workflow'});
 expect(api.job.jobId).toBe('fixture');expect(workflowJudgeRuntime).toHaveBeenCalledOnce();expect(state.bootstrap).toHaveBeenCalledWith(undefined);
 const results=await Promise.allSettled(Array.from({length:24},(_,i)=>state.runtime.beforeDispatch({kind:'gateway',operationId:`test:${i}`})));
 expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(16);await api.dispose();
 }finally{vi.unstubAllEnvs();}
});
