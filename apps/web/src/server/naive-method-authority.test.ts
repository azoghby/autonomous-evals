import { createHash } from 'node:crypto';
import { canonicalJson } from '@ae/core/evals/text/freeze';
import { readFileSync } from 'node:fs';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe,it,expect } from 'vitest';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { executeSuite } from '@ae/core/evals/text/execute';
import { evaluateObjectiveCheck } from '@ae/core/evals/text/objective';
import { makeSuite } from '@ae/core/evals/text/__tests__/fixtures';
import { createNaiveMethodAuthority,retainedNaiveExecutionProfile } from './naive-method-authority';
const jobId='123e4567-e89b-42d3-a456-426614174000';
const ctx={jobId,environment:'test' as const,budgetMicroUsd:1000000,recordCost:async()=>{},recordProgress:async()=>{}};
async function fixture(path?:string){
 const pg=new PGlite(path);
 await pg.exec(readFileSync(resolve('packages/core/src/evals/integration/migrations/001-text-integration.sql'),'utf8'));
 await pg.exec(`CREATE TABLE IF NOT EXISTS jobs(id uuid PRIMARY KEY,customer_id text,environment text,package text,is_mock boolean,state text,intake jsonb,retest_of_job_id uuid,credentials_delete_after timestamptz);CREATE TABLE IF NOT EXISTS job_credentials(job_id uuid PRIMARY KEY,ciphertext text);`);
 const suite=makeSuite({jobId,versionLabel:'generic-text-v1'});
 await pg.query(`INSERT INTO jobs VALUES($1,'owner','test','text_eval',false,'planning',$2,null,null) ON CONFLICT DO NOTHING`,[jobId,JSON.stringify({package:'text_eval',authorizedToTest:true,endpoint:{url:'https://example.com/chat',model:'fixture',systemPrompt:suite.systemPrompt},_credentialSlots:['endpoint']})]);
 await pg.query(`INSERT INTO job_credentials VALUES($1,'test-key') ON CONFLICT DO NOTHING`,[jobId]);
 const sql:AgentTransactionalSql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
 let decision:'approved'|'pending'|'rejected'='pending',revoked=false;
 const create=()=>createNaiveMethodAuthority(ctx,{sql,decryptCredentials:ciphertext=>({endpoint:ciphertext}),admissionPolicy:async()=>decision==='approved'?{status:'approved',approvalArtifactId:'policy-exact-v1'}:{status:decision},authorizeApproval:async(_tx,id)=>{if(revoked||id!=='policy-exact-v1')throw Error('approval revoked');}});
 return {pg,sql,create,suite,decision:(d:typeof decision)=>{decision=d;},revoke:()=>{revoked=true;}};
}
describe('generic text canonical authority real SQL',()=>{
 it('retains canonical bindings across close/reopen, rejects changed secret and never stores keys',async()=>{
  const path=await mkdtemp(join(tmpdir(),'generic-authority-'));let f=await fixture(path);
  try{await f.create();const rows=await f.pg.query('SELECT value FROM text_integration.checkpoints');expect(JSON.stringify(rows.rows)).not.toContain('test-key');await f.pg.close();f=await fixture(path);await f.create();await f.pg.query(`UPDATE job_credentials SET ciphertext='rotated-key'`);await expect(f.create()).rejects.toThrow('authority');}finally{await f.pg.close();await rm(path,{recursive:true,force:true});}
 });
 it('pending cannot approve and rejection survives retry',async()=>{
  const f=await fixture();try{const a=await f.create(),id=await a.designIdentity();expect((await a.artifacts.admission.admit(id,f.suite)).status).toBe('pending');await expect(a.resolveSuite()).rejects.toThrow('pending');f.decision('rejected');expect((await a.artifacts.admission.admit(id,f.suite)).status).toBe('rejected');f.decision('approved');expect((await a.artifacts.admission.admit(id,f.suite)).status).toBe('rejected');}finally{await f.pg.close();}
 });
 it('replays lost approval acknowledgement, rejects public mutation and approval revocation',async()=>{
  const f=await fixture();try{f.decision('approved');const a=await f.create(),id=await a.designIdentity();const receipt=await a.artifacts.admission.admit(id,f.suite);const fresh=await f.create();expect(await fresh.artifacts.admission.admit(id,f.suite)).toEqual(receipt);const resolved=await fresh.resolveSuite();await expect(fresh.resolveSuite({...resolved.suite,versionLabel:'other'})).rejects.toThrow();f.revoke();await expect(fresh.resolveSuite()).rejects.toThrow('revoked');}finally{await f.pg.close();}
 });
 it('retains full immutable rich runs and investigations through fresh authority reconstruction',async()=>{
  const f=await fixture();try{f.decision('approved');const a=await f.create();await a.artifacts.admission.admit(await a.designIdentity(),f.suite);const r=await a.resolveSuite();
   const run=await executeSuite(r.frozen,r.runId,{target:{send:async()=>({ok:true,text:'WRONG',latencyMs:1})},judge:null,evaluateObjective:evaluateObjectiveCheck});
   const body={schemaVersion:'naive_contract_run.v1' as const,scope:r.scope,run};const identity={runId:r.runId,targetVersion:r.targetVersion};await a.artifacts.persistRun(ctx,body,identity);
   const b=await f.create();expect(await b.artifacts.loadRun(ctx,r.scope,r.runId,r.targetVersion)).toEqual(body);
   await expect(b.artifacts.persistRun(ctx,{...body,run:{...run,executions:run.executions.map(e=>({...e,responseText:'substitution'}))}},identity)).rejects.toThrow();
   const investigation={scope:r.scope,...identity,investigation:{findings:[],costs:[],reproductions:[],testDefects:[],limitations:['exact retained investigation'],investigatorStatus:'completed' as const}};
   await b.artifacts.persistInvestigation(ctx,investigation);await b.artifacts.persistInvestigation(ctx,investigation);
   await expect(b.artifacts.persistInvestigation(ctx,{...investigation,investigation:{...investigation.investigation,limitations:['changed']}})).rejects.toThrow();
   f.revoke();await expect(b.current()).rejects.toThrow('revoked');await expect(b.artifacts.persistRun(ctx,body,identity)).rejects.toThrow('revoked');
  }finally{await f.pg.close();}
 });
 it('refuses changed owner/environment/intake, expired/deleted credentials and revoked publication',async()=>{
  const f=await fixture();try{const a=await f.create();await f.pg.query(`UPDATE jobs SET customer_id='other'`);await expect(a.current()).rejects.toThrow();await expect(f.create()).rejects.toThrow();await f.pg.query(`UPDATE jobs SET customer_id='owner',environment='live'`);await expect(a.current()).rejects.toThrow();await f.pg.query(`UPDATE jobs SET environment='test',credentials_delete_after=now()-interval '1 second'`);await expect(a.current()).rejects.toThrow();await f.pg.query(`UPDATE jobs SET credentials_delete_after=null`);await f.pg.query('DELETE FROM job_credentials');await expect(a.current()).rejects.toThrow();}finally{await f.pg.close();}
 });
 it('current gates dispatch and publication after job revocation; changed intake cannot replace a slot',async()=>{
  const f=await fixture();try{const a=await f.create();await f.pg.query(`UPDATE jobs SET intake=jsonb_set(intake,'{notes}','"changed"')`);await expect(a.current()).rejects.toThrow();await expect(f.create()).rejects.toThrow();await f.pg.query(`UPDATE jobs SET state='cancelled'`);await expect(a.current()).rejects.toThrow();}finally{await f.pg.close();}
 });
});

it('retained profile rejects conflicting bindings and rehashed malformed selection without dispatch permission',async()=>{
 const f=await fixture();try{
  await f.create();
  await f.pg.query(`INSERT INTO text_integration.checkpoints SELECT job_id,kind,'generic-text-factual-gap-v1',input_digest,token,state,value FROM text_integration.checkpoints WHERE kind='naive_method_binding'`);
  await expect(f.sql.transaction(tx=>retainedNaiveExecutionProfile(tx,jobId))).rejects.toThrow();
  await f.pg.query(`DELETE FROM text_integration.checkpoints WHERE id='generic-text-factual-gap-v1'`);
  const value={schemaVersion:'naive_text_execution_selection.v1',identity:{jobId,customerId:'owner',environment:'test'},profile:{policyId:'generic-text-v1',designId:'generic-text-v1',versionLabel:'generic-text-v1',admissionPolicyId:'automated-text-design-v1',expertTaskId:'unexpected'}};
  await f.pg.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_execution_policy','selection-v1',$2,'selection','completed',$3)`,[jobId,createHash('sha256').update(canonicalJson(value)).digest('hex'),JSON.stringify(value)]);
  await expect(f.create()).rejects.toThrow();
 }finally{await f.pg.close();}
});
