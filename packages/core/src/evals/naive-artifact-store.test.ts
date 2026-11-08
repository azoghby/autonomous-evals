import {mkdtemp,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PGlite} from '@electric-sql/pglite';
import {describe,it,expect} from 'vitest';
import type {AgentTransactionalSql} from '../agents/postgres-ports';
import {createNaiveArtifactStore} from './naive-artifact-store';
import {executeSuite} from './text/execute';
import {evaluateObjectiveCheck} from './text/objective';
import {makeSuite} from './text/__tests__/fixtures';
const jobId='123e4567-e89b-42d3-a456-426614174000';
const identity={jobId,customerId:'owner',environment:'test' as const,designId:'design',versionLabel:'fixture-v1',inputDigest:'a'.repeat(64)};
const suite=makeSuite({jobId});
async function setup(path?:string){
 const pg=new PGlite(path);await pg.exec(readFileSync(new URL('./integration/migrations/001-text-integration.sql',import.meta.url),'utf8'));
 const sql:AgentTransactionalSql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
 let revoked=false,secrets:string[]=[];let decision:'approved'|'pending'|'rejected'='approved';
 const store=createNaiveArtifactStore({sql,authorize:async(_tx,scope)=>{if(revoked||scope.customerId!=='owner')throw Error('denied');return {knownSecrets:secrets};},decide:async()=>decision==='approved'?{status:'approved',approvalArtifactId:'trusted-approval'}:{status:decision}});
 return {pg,sql,store,revoke:()=>{revoked=true;},secret:(s:string)=>{secrets=[s];},decision:(s:typeof decision)=>{decision=s;}};
}
describe('Naive authority artifacts on SQL',()=>{
 it('retains genuine admission through database reopen and reauthorizes reads',async()=>{
  const path=await mkdtemp(join(tmpdir(),'naive-artifact-'));const f=await setup(path);
  try{const admitted=await f.store.admission.admit(identity,suite);expect(admitted.status).toBe('approved');await f.pg.close();
   const g=await setup(path);try{expect(await g.store.admission.load(identity)).toEqual(admitted);g.revoke();await expect(g.store.admission.load(identity)).rejects.toThrow('denied');}finally{await g.pg.close();}
  }finally{await rm(path,{recursive:true,force:true});}
 });
 it('supports concurrent identical admission and rejects changed owner/input or body',async()=>{
  const f=await setup();try{const values=await Promise.all([f.store.admission.admit(identity,suite),f.store.admission.admit(identity,suite)]);expect(values[0]).toEqual(values[1]);
   await expect(f.store.admission.load({...identity,inputDigest:'b'.repeat(64)})).rejects.toThrow('mismatch');
   await expect(f.store.admission.load({...identity,customerId:'other'})).rejects.toThrow('denied');
   await expect(f.store.admission.admit(identity,makeSuite({jobId,frozenAt:'2026-11-08T00:00:00Z'}))).rejects.toThrow('mismatch');
  }finally{await f.pg.close();}
 });
 it('does not turn a pending review into durable approval and keeps rejection immutable',async()=>{
  const f=await setup();try{f.decision('pending');expect((await f.store.admission.admit(identity,suite)).status).toBe('pending');expect(await f.store.admission.load(identity)).toBeNull();
   f.decision('rejected');expect((await f.store.admission.admit(identity,suite)).status).toBe('rejected');f.decision('approved');expect((await f.store.admission.admit(identity,suite)).status).toBe('rejected');
  }finally{await f.pg.close();}
 });
 it('rolls back artifact writes if final current authorization fails',async()=>{
  const f=await setup();try{let calls=0;const g=createNaiveArtifactStore({sql:f.sql,authorize:async()=>{if(++calls===3)throw Error('revoked');return {knownSecrets:[]};},decide:async()=>({status:'approved',approvalArtifactId:'trusted'})});
   await expect(g.admission.admit(identity,suite)).rejects.toThrow('revoked');expect(await f.store.admission.load(identity)).toBeNull();
  }finally{await f.pg.close();}
 });
 it('rechecks current secrets on retained admission and validates replay after lost acknowledgement',async()=>{
  const f=await setup();try{const saved=await f.store.admission.admit(identity,suite);const replay=await f.store.admission.admit(identity,suite);expect(replay).toEqual(saved);
   f.secret('Follow the explicit user constraints.');await expect(f.store.admission.load(identity)).rejects.toThrow('mismatch');
  }finally{await f.pg.close();}
 });
 it('checks specific retained approval revocation even when job ownership remains valid',async()=>{
  const f=await setup();try{await f.store.admission.admit(identity,suite);
   const g=createNaiveArtifactStore({sql:f.sql,authorize:async(_tx,scope)=>{if(scope.approvalArtifactId==='trusted-approval')throw Error('approval revoked');return {knownSecrets:[]};},decide:async()=>({status:'approved',approvalArtifactId:'other'})});
   await expect(g.admission.load(identity)).rejects.toThrow('approval revoked');
  }finally{await f.pg.close();}
 });

 it('persists a bound rich run and rejects a fabricated investigation finding',async()=>{
  const f=await setup();try{
   const admission=await f.store.admission.admit(identity,suite);if(admission.status!=='approved')throw Error();
   const scope=admission.artifact.scope,ctx={jobId,environment:'test' as const,budgetMicroUsd:1000000,recordCost:async()=>{},recordProgress:async()=>{}};
   const run=await executeSuite(suite,'run-1',{target:{send:async()=>({ok:true,text:'WRONG',latencyMs:1})},judge:null,evaluateObjective:evaluateObjectiveCheck});
   const artifact={schemaVersion:'naive_contract_run.v1' as const,scope,run};
   await f.store.persistRun(ctx,artifact,{runId:'run-1',targetVersion:'target-v1'});
   expect(await f.store.loadRun(ctx,scope,'run-1','target-v1')).toEqual(artifact);
   await expect(f.store.loadRun(ctx,scope,'run-1','other-target')).rejects.toThrow('mismatch');
   await expect(f.store.persistInvestigation(ctx,{scope,runId:'run-1',targetVersion:'target-v1',investigation:{findings:[{id:'fabricated',source:'text_eval',category:'explicit_constraint',title:'Fake',label:'confirmed',severity:'medium',basis:'objective',summary:'Fake',evidence:[{kind:'check',checkId:'fabricated-check',detail:'Fake'}],investigatorNote:null,reproduction:null}],costs:[],reproductions:[],testDefects:[],limitations:[],investigatorStatus:'completed'}})).rejects.toThrow('mismatch');
  }finally{await f.pg.close();}
 });

});
