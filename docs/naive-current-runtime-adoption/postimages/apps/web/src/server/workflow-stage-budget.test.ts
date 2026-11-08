import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import type { WorkflowStageScope } from './workflow-stage-runtime';
const state=vi.hoisted(()=>({admit:vi.fn(),settle:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./workflow-stage-runtime',()=>({currentWorkflowStageScope:()=>undefined}));
vi.mock('@ae/core/db/job-budget-ledger',()=>({SharedJobBudgetLedger:class {
 constructor(private sql:AgentTransactionalSql,private owner?:()=>Promise<unknown>){}
 reserve(input:unknown){return this.sql.transaction(async()=>{const owner=await this.owner?.();return state.admit(input,owner);});}
 settle(...args:unknown[]){return state.settle(...args);}
}}));
import { createWorkflowStageBudgetLedger } from './workflow-stage-budget';
const input={reservationId:'child',jobId:'job',amountMicroUsd:10,scopes:[{key:'job:job',capMicroUsd:100}]};
function fixture(){
 let active=true,commits=0;
 const sql:AgentTransactionalSql={query:async()=>({rows:[]}),transaction:async fn=>{const result=await fn(sql);commits++;return result;}};
 const owner={jobId:'job',stageKey:'stage',token:'token',generation:2};
 const scope={owner,assertActive:()=>{if(!active)throw Error('revoked');}} as WorkflowStageScope;
 return {sql,scope,owner,revoke:()=>{active=false;},commits:()=>commits};
}
describe('Workflow stage budget host wiring',()=>{
 beforeEach(()=>{vi.clearAllMocks();state.admit.mockResolvedValue({ok:true,reservationId:'child'});state.settle.mockResolvedValue({settledMicroUsd:5});});
 it('passes only trusted current owner and commits a scoped admission',async()=>{
  const f=fixture();await createWorkflowStageBudgetLedger(f.sql,()=>f.scope).reserve(input);
  expect(state.admit).toHaveBeenCalledWith(input,f.owner);expect(f.commits()).toBe(1);
 });
 it('rolls back admission when local authority is revoked during SQL work',async()=>{
  const f=fixture();state.admit.mockImplementation(async()=>{f.revoke();return {ok:true};});
  await expect(createWorkflowStageBudgetLedger(f.sql,()=>f.scope).reserve(input)).rejects.toThrow('revoked');expect(f.commits()).toBe(0);
 });
 it('rejects revoked admission before SQL but still permits measured settlement',async()=>{
  const f=fixture(),ledger=createWorkflowStageBudgetLedger(f.sql,()=>f.scope);f.revoke();
  expect(()=>ledger.reserve(input)).toThrow('revoked');expect(state.admit).not.toHaveBeenCalled();
  await expect(ledger.settle('child',5)).resolves.toEqual({settledMicroUsd:5});
 });
 it('retains standalone and expert honorarium admission without parent attachment',async()=>{
  const f=fixture();await createWorkflowStageBudgetLedger(f.sql).reserve(input);
  f.revoke();await createWorkflowStageBudgetLedger(f.sql,()=>f.scope).reserve({...input,scopes:[{key:'expert-job:job',capMicroUsd:100}]});
  expect(state.admit.mock.calls.every(call=>call[1]===undefined)).toBe(true);
 });
});
