import { describe,it,expect,vi } from 'vitest';
vi.mock('server-only',()=>({}));
const accounting=vi.hoisted(()=>({drain:vi.fn()}));
vi.mock('./judge-owner-recovery',()=>({drainJudgeAccounting:accounting.drain}));
vi.mock('./judge-owner-recovery-production',()=>({trustedJudgeAccountingDependencies:()=>({})}));
vi.mock('./workflow-stage-runtime',()=>({currentWorkflowStageScope:()=>undefined}));
import { selectJudgeAttemptMode, drainRuntimeJudgeAccounting } from './judge-attempt-runtime';
import { proxyBillingDigest } from '@ae/core/judges/naive-proxy-reconcile';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
const jobId='11111111-1111-4111-8111-111111111111',operationId='judge:test';
function database(input:{v1?:boolean;v2?:boolean;mode?:string;schema?:boolean}={}) {
 const calls:string[]=[];let mode=input.mode;
 const sql:AgentTransactionalSql={transaction:fn=>fn(sql),query:async<R>(q:string,args?:unknown[])=>{
  calls.push(q);let rows:unknown[]=[];
  if(q.startsWith('SELECT package'))rows=[{package:'text_eval'}];
  else if(q.includes('to_regclass'))rows=[{present:input.schema!==false}];
  else if(q.startsWith('SELECT 1 FROM naive_proxy_dispatch'))rows=input.v2?[{}]:[];
  else if(q.startsWith('SELECT 1 FROM text_integration'))rows=input.v1?[{}]:[];
  else if(q.startsWith('SELECT value,input_digest,state'))rows=mode?[{value:{mode},input_digest:proxyBillingDigest({jobId,operationId}),state:'completed'}]:[];
  else if(q.startsWith('INSERT INTO text_integration'))mode=JSON.parse(args![3] as string).mode;
  return {rows:rows as R[]};
 }};return {sql,calls};
}
describe('operation mode retention',()=>{
 it('freezes fresh v1 choice when activation later changes',async()=>{const {sql}=database();expect(await selectJudgeAttemptMode(sql,jobId,operationId,false)).toBe('v1');expect(await selectJudgeAttemptMode(sql,jobId,operationId,true)).toBe('v1');});
 it('keeps historical v1 identity under activation',async()=>{expect(await selectJudgeAttemptMode(database({v1:true}).sql,jobId,operationId,true)).toBe('v1');});
 it('keeps retained v2 when fresh activation is disabled',async()=>{expect(await selectJudgeAttemptMode(database({v2:true}).sql,jobId,operationId,false)).toBe('v2');});
 it('fails closed on conflicting historical identities',async()=>{await expect(selectJudgeAttemptMode(database({v1:true,v2:true}).sql,jobId,operationId,true)).rejects.toThrow();});
 it('fails closed on missing sidecar for retained v2',async()=>{await expect(selectJudgeAttemptMode(database({mode:'v2',schema:false}).sql,jobId,operationId,false)).rejects.toThrow();});
 it('does not pin fresh mode metadata after revocation',async()=>{const {sql,calls}=database();await expect(selectJudgeAttemptMode(sql,jobId,operationId,true,async()=>{throw Error('revoked');})).rejects.toThrow('revoked');expect(calls.some(q=>q.startsWith('INSERT'))).toBe(false);});
 it('locks canonical job before operation identity',async()=>{const {sql,calls}=database();await selectJudgeAttemptMode(sql,jobId,operationId,true);expect(calls[0]).toContain('FOR UPDATE');expect(calls[2]).toContain('pg_advisory_xact_lock');});
});

describe('independent runtime accounting',()=>{
 it('holds unfinished incurred receipts before paid authority is created',async()=>{
  accounting.drain.mockResolvedValueOnce({pending:1,remaining:false});
  const sql:AgentTransactionalSql={query:async<R>()=>({rows:[{}] as R[]}),transaction:async()=>{throw Error('paid authority must not be constructed');}};
  await expect(drainRuntimeJudgeAccounting(jobId,sql)).rejects.toThrow('requires reconciliation');
 });
 it('traverses retained cursors before returning',async()=>{
  accounting.drain.mockResolvedValueOnce({pending:0,remaining:true,nextCursor:'a'.repeat(64)}).mockResolvedValueOnce({pending:0,remaining:false});
  const sql:AgentTransactionalSql={query:async<R>()=>({rows:[{}] as R[]}),transaction:async()=>{throw Error('unused');}};
  await expect(drainRuntimeJudgeAccounting(jobId,sql)).resolves.toBeUndefined();
  expect(accounting.drain.mock.calls.at(-1)?.[2]).toBe('a'.repeat(64));
 });
});
