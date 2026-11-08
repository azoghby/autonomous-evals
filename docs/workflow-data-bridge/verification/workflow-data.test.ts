import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createWorkflowInventory } from '@/server/workflow-inventory';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
const calls = vi.hoisted(() => ({ advance: vi.fn() }));
vi.mock('@/server/data-production', () => ({ advanceProductionData: calls.advance }));
import { registerWorkflowDataPlan, readWorkflowDataReady, advanceWorkflowData } from '@workflow-data';

const scope = {jobId:'a1b2c3d4-e5f6-4abc-8def-aabbccddeeff',tenantId:'b1c2d3e4-f5a6-4abc-8def-bbccddeeffaa',environment:'test' as const,workflowRunId:'workflow-current'};
const task = {taskId:'data_task',jobId:scope.jobId,description:'Review case',requirements:[{id:'case_req',description:'One reviewed case',minimumCases:1}],factualAnswersRequired:false,targetId:'target'};
const input = {task,initial:{sources:[],cases:[]},context:{versionLabel:'default',systemPrompt:null}};
let pg: PGlite, sql:AgentTransactionalSql;
const result = (status:string) => ({status,task:{spec:task,status:'waiting_for_review',sources:[],cases:[],costs:[]},progress:{outcome:'inconclusive',factualCorrectness:'unassessed',message:'Pending review'}});
const inventory = () => ({acquisition:vi.fn(async (_ids:string[]) => {}),touch:vi.fn(async()=>{})});
beforeEach(async()=>{
 vi.clearAllMocks(); pg=new PGlite();
 await pg.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,environment text,workflow_run_id text,package text,is_mock boolean,state text); CREATE SCHEMA workflow_integration; CREATE SCHEMA evaluation_data_persistence; CREATE TABLE evaluation_data_persistence.tasks(tenant_id uuid,job_id uuid,task_id text);`);
 await pg.query('INSERT INTO jobs VALUES($1,$2,$3,$4,$5,false,$6)',[scope.jobId,scope.tenantId,scope.environment,scope.workflowRunId,'text_eval','planning']);
 await pg.exec(readFileSync(join(process.env.BRIDGE_STAGE!,'apps/web/migrations/003-workflow-data.sql'),'utf8'));
 sql={query:async<T>(q:string,p:unknown[]=[])=>({rows:(await pg.query(q,p)).rows as T[]}),transaction:async fn=>pg.transaction(async tx=>fn({query:async<T>(q:string,p:unknown[]=[])=>({rows:(await tx.query(q,p)).rows as T[]})}))};
});
afterEach(async()=>{await pg.close();});
describe('actual applied durable Workflow data composition',()=>{
 it('registers expected task before dispatch even before task storage exists',async()=>{
  await registerWorkflowDataPlan(sql,scope,input,[]);const inv=inventory();const order:string[]=[];
  inv.acquisition.mockImplementation(async ids=>{expect(ids).toEqual([task.taskId]);order.push('inventory');});
  calls.advance.mockImplementation(async (jobId,plan)=>{order.push('advance');expect(jobId).toBe(scope.jobId);expect(plan).toEqual(input);return result('waiting_for_review');});
  expect((await advanceWorkflowData(sql,scope,[],inv))?.status).toBe('waiting_for_review');expect(order).toEqual(['inventory','advance']);expect(inv.touch).toHaveBeenCalledTimes(2);
 });
 it('commits actual expected task inventory before production can write its first task',async()=>{
  await pg.exec(readFileSync(join(process.env.BRIDGE_ROOT!,'docs/structured-progress-integration/backend/001-structured-progress.sql'),'utf8'));
  await registerWorkflowDataPlan(sql,scope,input,[]);
  calls.advance.mockImplementation(async()=>{
   const published=(await pg.query<{plan:{acquisitionTaskIds:string[]}}>('SELECT plan FROM structured_progress.inventory')).rows[0];
   expect(published.plan.acquisitionTaskIds).toEqual([task.taskId]);
   expect((await pg.query('SELECT * FROM evaluation_data_persistence.tasks')).rows).toHaveLength(0);
   return result('waiting_for_review');
  });
  await advanceWorkflowData(sql,scope,[],createWorkflowInventory(sql,scope));
  expect(calls.advance).toHaveBeenCalledOnce();
  expect((await pg.query<{revision:number}>('SELECT revision FROM structured_progress.inventory')).rows[0].revision).toBe(2);
 });
 it.each(['waiting_for_data','waiting_for_review','reconciliation_required','cost_delivery_pending','mapping_blocked'])('preserves exact %s snapshot with no ready admission',async status=>{
  await registerWorkflowDataPlan(sql,scope,input,[]);const returned={...result(status),privateDetail:{costs:'unknown',review:'pending'}};calls.advance.mockResolvedValue(returned);
  expect(await advanceWorkflowData(sql,scope,[],inventory())).toEqual(returned);
  expect((await pg.query<{result:unknown}>('SELECT result FROM workflow_integration.data_advances')).rows[0].result).toEqual(returned);
  expect(await readWorkflowDataReady(sql,scope,[])).toBeNull();
 });
 it('replays exact ready suite/provenance after reconstruction without production redispatch',async()=>{
  await registerWorkflowDataPlan(sql,scope,input,[]);
  const ready={...result('ready'),frozen:{suite:{digest:'a'.repeat(64),privateSuite:'retained exact'},provenance:{taskId:task.taskId,sourceIds:['approved-source']}}};calls.advance.mockResolvedValue(ready);
  expect(await advanceWorkflowData(sql,scope,[],inventory())).toEqual(ready);
  expect(await advanceWorkflowData(sql,scope,[],inventory())).toEqual(ready);expect(calls.advance).toHaveBeenCalledTimes(1);
  expect(await readWorkflowDataReady(sql,scope,[])).toEqual({input,result:ready});
  await expect(registerWorkflowDataPlan(sql,scope,{...input,context:{versionLabel:'changed',systemPrompt:null}},[])).rejects.toThrow();
 });
 it('blocks unknown tasks and never dispatches without the exact authorized plan',async()=>{
  const inv=inventory();expect(await advanceWorkflowData(sql,scope,[],inv)).toBeNull();
  await pg.query('INSERT INTO evaluation_data_persistence.tasks VALUES($1,$2,$3)',[scope.tenantId,scope.jobId,'unplanned']);
  await expect(advanceWorkflowData(sql,scope,[],inv)).rejects.toThrow();expect(inv.acquisition).toHaveBeenCalledWith(['unplanned']);expect(calls.advance).not.toHaveBeenCalled();
  await registerWorkflowDataPlan(sql,scope,input,[]);await expect(advanceWorkflowData(sql,scope,[],inv)).rejects.toThrow();expect(calls.advance).not.toHaveBeenCalled();
 });
 it('blocks cross-tenant, stale Workflow and rotated secret plans before production',async()=>{
  await expect(registerWorkflowDataPlan(sql,{...scope,tenantId:'c1d2e3f4-a5b6-4abc-8def-ccddeeffaabb'},input,[])).rejects.toThrow();
  await registerWorkflowDataPlan(sql,scope,input,[]);
  await expect(advanceWorkflowData(sql,{...scope,workflowRunId:'stale'},[],inventory())).rejects.toThrow();
  await expect(advanceWorkflowData(sql,scope,['Review case'],inventory())).rejects.toThrow();expect(calls.advance).not.toHaveBeenCalled();
 });
 it('refreshes inventory on production failure and retains no fabricated ready state',async()=>{
  await registerWorkflowDataPlan(sql,scope,input,[]);const inv=inventory();calls.advance.mockRejectedValue(new Error('dispatch lost'));
  await expect(advanceWorkflowData(sql,scope,[],inv)).rejects.toThrow('dispatch lost');expect(inv.touch).toHaveBeenCalledOnce();expect(await readWorkflowDataReady(sql,scope,[])).toBeNull();
 });
 it('refuses mismatched returned task and detects private ready payload mutation',async()=>{
  await registerWorkflowDataPlan(sql,scope,input,[]);calls.advance.mockResolvedValue({...result('ready'),task:{spec:{...task,targetId:'changed'}},frozen:{suite:{},provenance:{}}});
  await expect(advanceWorkflowData(sql,scope,[],inventory())).rejects.toThrow();
  calls.advance.mockResolvedValue({...result('ready'),frozen:{suite:{},provenance:{}}});await advanceWorkflowData(sql,scope,[],inventory());
  await pg.query("UPDATE workflow_integration.data_ready SET result=jsonb_set(result,'{status}','\"waiting_for_review\"')");
  await expect(readWorkflowDataReady(sql,scope,[])).rejects.toThrow();
 });
});
