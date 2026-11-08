import {resolveJobNaiveExecution} from './naive-text-execution-runtime';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach,expect,it } from 'vitest';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { enrollNewNaiveTextExecution,resolveNaiveTextExecution } from './naive-text-execution-selection';
const identity={jobId:'123e4567-e89b-42d3-a456-426614174000',customerId:'223e4567-e89b-42d3-a456-426614174000',environment:'test' as const};
const enabled={realMode:true,factualGapEnabled:true};
const dbs:PGlite[]=[];
afterEach(async()=>{for(const pg of dbs.splice(0))await pg.close();});
async function fixture(){
 const pg=new PGlite();dbs.push(pg);
 await pg.exec('CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,environment text,package text,is_mock boolean)');
 await pg.exec(readFileSync('packages/core/src/evals/integration/migrations/001-text-integration.sql','utf8'));
 const sql:AgentTransactionalSql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};
 async function insert(tx:Parameters<Parameters<AgentTransactionalSql['transaction']>[0]>[0]){await tx.query(`INSERT INTO jobs VALUES($1,$2,'test','text_eval',false)`,[identity.jobId,identity.customerId]);}
 async function enroll(factualGapEnabled=true,expertTaskId='owner-task-v1'){return sql.transaction(async tx=>{await insert(tx);return enrollNewNaiveTextExecution(tx,identity,{factualGapEnabled,expertTaskId});});}
 async function bind(id:string){const value={job:identity,designId:id,versionLabel:id};await pg.query(`INSERT INTO text_integration.checkpoints VALUES($1,'naive_method_binding',$2,$3,'token','completed',$4::jsonb)`,[identity.jobId,id,reviewDigest(value),JSON.stringify(value)]);}
 return {pg,sql,insert,enroll,bind,resolve:(options=enabled)=>resolveNaiveTextExecution(sql,identity,options)};
}
it('an absent enrollment marker pins legacy despite enabled flags',async()=>{const f=await fixture();await f.sql.transaction(f.insert);expect(await f.resolve()).toMatchObject({status:'ready',profile:{designId:'generic-text-v1'}});expect(await f.resolve()).toEqual(await f.resolve());});
it('atomically enrolls a new job and pins exact owner task across restart',async()=>{const f=await fixture();const profile=await f.enroll();expect(profile).toMatchObject({designId:'generic-text-factual-gap-v1',factualGapPolicy:'propose_missing_reference.v1',expertTaskId:'owner-task-v1'});expect(await f.resolve()).toEqual({status:'ready',profile});expect(await f.sql.transaction(tx=>enrollNewNaiveTextExecution(tx,identity,{factualGapEnabled:true,expertTaskId:'owner-task-v1'}))).toEqual(profile);});
it('rolls back job insertion with invalid enrollment',async()=>{const f=await fixture();await expect(f.enroll(true,'bad task')).rejects.toThrow();expect((await f.pg.query('SELECT * FROM jobs')).rows).toHaveLength(0);});
it('rollback flags hold selected factual jobs without rewriting identity',async()=>{const f=await fixture();const profile=await f.enroll();for(const options of [{realMode:true,factualGapEnabled:false},{realMode:false,factualGapEnabled:true}])expect(await f.resolve(options)).toEqual({status:'on_hold',profile});expect(await f.resolve()).toEqual({status:'ready',profile});});
it('disabled real mode holds legacy execution too',async()=>{const f=await fixture();await f.enroll(false);expect(await f.resolve({realMode:false,factualGapEnabled:false})).toMatchObject({status:'on_hold',profile:{designId:'generic-text-v1'}});});
it('rejects changed task and attempted upgrade of a pinned legacy job',async()=>{const f=await fixture();await f.enroll(false);await expect(f.sql.transaction(tx=>enrollNewNaiveTextExecution(tx,identity,{factualGapEnabled:true,expertTaskId:'owner-task-v1'}))).rejects.toThrow('selection_conflict');const g=await fixture();await g.enroll();await expect(g.sql.transaction(tx=>enrollNewNaiveTextExecution(tx,identity,{factualGapEnabled:true,expertTaskId:'different-task'}))).rejects.toThrow('selection_conflict');});
it('accepts exact legacy binding without a selection marker',async()=>{const f=await fixture();await f.sql.transaction(f.insert);await f.bind('generic-text-v1');expect(await f.resolve()).toMatchObject({profile:{designId:'generic-text-v1'}});});
it('rejects multiple bindings, unknown versions, and unmarked new-policy bindings',async()=>{for(const ids of [['generic-text-v1','generic-text-factual-gap-v1'],['unknown'],['generic-text-factual-gap-v1']]){const f=await fixture();await f.sql.transaction(f.insert);for(const id of ids)await f.bind(id);await expect(f.resolve()).rejects.toThrow('selection_conflict');}});
it('rejects enrollment after any design binding',async()=>{const f=await fixture();await f.sql.transaction(f.insert);await f.bind('generic-text-v1');await expect(f.sql.transaction(tx=>enrollNewNaiveTextExecution(tx,identity,{factualGapEnabled:true,expertTaskId:'owner-task-v1'}))).rejects.toThrow('selection_conflict');});
it('rejects canonical owner/environment changes and corrupt checkpoint bodies',async()=>{const f=await fixture();await f.enroll();for(const changed of [{...identity,customerId:'323e4567-e89b-42d3-a456-426614174000'},{...identity,environment:'live' as const}])await expect(resolveNaiveTextExecution(f.sql,changed,enabled)).rejects.toThrow('selection_conflict');await f.pg.query(`UPDATE text_integration.checkpoints SET value=jsonb_set(value,'{profile,expertTaskId}','"changed"')`);await expect(f.resolve()).rejects.toThrow('selection_conflict');});

it('runtime refuses flag rollback before it can select lite for an enrolled factual job',async()=>{
 const f=await fixture();await f.enroll();
 for(const env of [{EVAL_SERVICES:'lite'},{EVAL_SERVICES:'real',EVAL_NAIVE_METHODS:''},{EVAL_SERVICES:'real',EVAL_NAIVE_METHODS:'designSuite,runSuite,investigate',EVAL_NAIVE_FACTUAL_GAPS:'0'}]){
  await expect(resolveJobNaiveExecution(identity.jobId,{sql:f.sql,env})).rejects.toThrow('NAIVE_EXECUTION_SELECTION_HOLD');
 }
 expect(await resolveJobNaiveExecution(identity.jobId,{sql:f.sql,env:{EVAL_SERVICES:'real',EVAL_NAIVE_METHODS:'designSuite,runSuite,investigate',EVAL_NAIVE_FACTUAL_GAPS:'1'}})).toMatchObject({generic:true,profile:{policyId:'generic-text-factual-gap-v1'}});
});
it('runtime keeps an unenrolled legacy job on its configured path without enabling factual policy',async()=>{
 const f=await fixture();await f.sql.transaction(f.insert);
 expect(await resolveJobNaiveExecution(identity.jobId,{sql:f.sql,env:{EVAL_SERVICES:'lite'}})).toEqual({generic:false});
 expect(await resolveJobNaiveExecution(identity.jobId,{sql:f.sql,env:{EVAL_SERVICES:'real',EVAL_NAIVE_METHODS:'designSuite,runSuite,investigate',EVAL_NAIVE_FACTUAL_GAPS:'1'}})).toMatchObject({generic:true,profile:{policyId:'generic-text-v1'}});
});
