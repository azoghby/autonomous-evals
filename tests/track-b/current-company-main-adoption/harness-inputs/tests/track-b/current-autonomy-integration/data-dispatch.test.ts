import {PGlite} from '@electric-sql/pglite';
import {expect,it,vi} from 'vitest';
import type {AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
import type {ProductionDataInput} from '@/server/data-production';
import {advanceWorkflowData,registerWorkflowDataPlan} from '@/server/workflow-data';
const legacy=vi.hoisted(()=>({dispatch:vi.fn(async()=>{throw Error('legacy dispatch forbidden');})}));
vi.mock('@/server/data-production',()=>({advanceProductionData:legacy.dispatch}));
it('real Workflow data SQL publishes inventory before trusted refusal, retains cleanup and never falls back',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE jobs(id text,customer_id text,environment text,workflow_run_id text,package text,is_mock boolean,state text);
   INSERT INTO jobs VALUES('job','tenant','test','durable-run','text_eval',false,'running');
   CREATE SCHEMA workflow_integration;
   CREATE TABLE workflow_integration.data_plans(job_id text PRIMARY KEY,tenant_id text,environment text,input_digest text,input jsonb);
   CREATE TABLE workflow_integration.data_ready(job_id text,input_digest text,result_digest text,result jsonb);
   CREATE SCHEMA evaluation_data_persistence;
   CREATE TABLE evaluation_data_persistence.tasks(tenant_id text,job_id text,task_id text);`);
  const sql:AgentTransactionalSql={query:(s,p)=>db.query(s,p),transaction:fn=>db.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};
  const scope={jobId:'job',tenantId:'tenant',environment:'test' as const,workflowRunId:'durable-run'};
  const input:ProductionDataInput={task:{taskId:'task',jobId:'job',targetId:'target',description:'Check permission reasoning',factualAnswersRequired:false,requirements:[{id:'permission',description:'Write authorization',minimumCases:1}]},initial:{sources:[],cases:[]},context:{versionLabel:'v1',systemPrompt:'fixture'}};
  await registerWorkflowDataPlan(sql,scope,input,[]);
  const events:string[]=[];
  const inventory={acquisition:vi.fn(async(ids:string[])=>{expect(ids).toEqual(['task']);events.push('inventory');}),touch:vi.fn(async()=>{events.push('touch');})};
  const dispatch=vi.fn(async()=>{events.push('trusted-dispatch');throw Error('autonomous-paid-data-adapter-required');});
  await expect(advanceWorkflowData(sql,scope,[],inventory,dispatch)).rejects.toThrow('autonomous-paid-data-adapter-required');
  expect(events).toEqual(['inventory','trusted-dispatch','touch']);expect(legacy.dispatch).not.toHaveBeenCalled();
  await db.query("UPDATE jobs SET workflow_run_id='revoked'");
  await expect(advanceWorkflowData(sql,scope,[],inventory,dispatch)).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledOnce();expect(inventory.acquisition).toHaveBeenCalledOnce();
 }finally{await db.close();}
},30000);
