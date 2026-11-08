import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createWorkflowInventory } from '@inventory';
import { persistRichArtifact, readRichArtifact } from '@rich';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
const root = process.env.WORKFLOW_ARTIFACTS_ROOT!;
const stage = process.env.WORKFLOW_STAGE!;
const scope = {jobId:'job-1',tenantId:'tenant-1',environment:'test' as const};
const digest='a'.repeat(64);
let pg:PGlite;
let db:AgentTransactionalSql;
beforeEach(async()=>{
 pg=new PGlite();
 await pg.exec(`CREATE TABLE jobs(id text PRIMARY KEY,customer_id text,environment text,package text); INSERT INTO jobs VALUES('job-1','tenant-1','test','text_eval'); CREATE SCHEMA workflow_integration;`);
 for(const file of [join(stage,'packages/core/src/evals/integration/migrations/001-text-integration.sql'),join(root,'docs/structured-progress-integration/backend/001-structured-progress.sql'),join(root,'docs/workflow-integration/workflow-producers/migrations/002-rich-artifacts.sql')])await pg.exec(readFileSync(file,'utf8'));
 const query=async<T>(sql:string,params:unknown[]=[])=>({rows:(await pg.query(sql,params)).rows as T[]});
 db={query,transaction:async callback=>pg.transaction(async tx=>callback({query:async<T>(sql:string,params:unknown[]=[])=>({rows:(await tx.query(sql,params)).rows as T[]})}))};
});
afterEach(async()=>{await pg.close();});
describe('independent actual applied inventory and private artifact SQL',()=>{
 it('publishes expected result before actual run claim and retains immutable pending state after reconstruction',async()=>{
  const key={jobId:scope.jobId,kind:'run_identity',id:'run-stable',inputDigest:digest};
  const associations={runId:'run-stable',suiteDigest:digest,scenarioIds:['case-1']};
  const base=new PostgresTextCheckpointStore(db);
  const inventory=createWorkflowInventory(db,scope);
  let observedBeforeClaim=false;
  const wrapped=inventory.wrap({...base,claim:async k=>{
   const row=(await db.query<{plan:{checkpoints:{key:{kind:string}}[]}}>('SELECT plan FROM structured_progress.inventory')).rows[0];
   observedBeforeClaim=row.plan.checkpoints[0].key.kind==='run_result';
   return base.claim(k);
  },get:base.get.bind(base),complete:base.complete.bind(base),release:base.release.bind(base),markAmbiguous:base.markAmbiguous.bind(base)});
  expect((await inventory.phase(associations,()=>wrapped.claim(key))).state).toBe('claimed');
  expect(observedBeforeClaim).toBe(true);
  const reconstructed=createWorkflowInventory(db,scope);
  expect((await reconstructed.phase(associations,()=>reconstructed.wrap(new PostgresTextCheckpointStore(db)).claim(key))).state).toBe('pending');
  expect((await db.query<{plan:{checkpoints:unknown[]}}>('SELECT plan FROM structured_progress.inventory')).rows[0].plan.checkpoints).toHaveLength(1);
  await expect(reconstructed.phase({...associations,runId:'changed'},()=>reconstructed.wrap(base).claim(key))).rejects.toThrow('workflow_inventory_identity_conflict');
 });
 it('does not claim when authorization or inventory persistence fails',async()=>{
  const key={jobId:scope.jobId,kind:'design',id:'suite',inputDigest:digest};
  const wrong=createWorkflowInventory(db,{...scope,tenantId:'other'});
  await expect(wrong.wrap(new PostgresTextCheckpointStore(db)).claim(key)).rejects.toThrow('workflow_inventory_scope');
  expect((await db.query('SELECT * FROM text_integration.checkpoints')).rows).toHaveLength(0);
  await pg.exec('DROP TABLE structured_progress.inventory');
  await expect(createWorkflowInventory(db,scope).wrap(new PostgresTextCheckpointStore(db)).claim(key)).rejects.toThrow();
  expect((await db.query('SELECT * FROM text_integration.checkpoints')).rows).toHaveLength(0);
 });
 it('requires run associations, but allows actual design claims without invented run IDs',async()=>{
  const key={jobId:scope.jobId,kind:'run_result',id:'run',inputDigest:digest};
  await expect(createWorkflowInventory(db,scope).wrap(new PostgresTextCheckpointStore(db)).claim(key)).rejects.toThrow('workflow_inventory_associations_required');
  const design={...key,kind:'design'};
  expect((await createWorkflowInventory(db,scope).wrap(new PostgresTextCheckpointStore(db)).claim(design)).state).toBe('claimed');
 });
 it('persists rich evidence exactly once, rejects altered replays and hides other tenant artifacts',async()=>{
  const body={status:'unresolved',findings:[],limits:['factual correctness not assessed']};
  await persistRichArtifact(db,scope,digest,body,[]);
  await persistRichArtifact(db,scope,digest,JSON.parse(JSON.stringify(body)),[]);
  expect((await db.query('SELECT * FROM workflow_integration.rich_artifacts')).rows).toHaveLength(1);
  expect(await readRichArtifact(db,scope.jobId,scope.tenantId,[])).toEqual(body);
  await expect(readRichArtifact(db,scope.jobId,scope.tenantId,['unresolved'])).rejects.toThrow('rich_evidence_refused');
  expect(await readRichArtifact(db,scope.jobId,'other',[])).toBeNull();
  await expect(persistRichArtifact(db,scope,digest,{...body,status:'completed'},[])).rejects.toThrow('rich_evidence_conflict');
  await expect(persistRichArtifact(db,{...scope,environment:'live'},digest,body,[])).rejects.toThrow('rich_evidence_scope');
  await expect(persistRichArtifact(db,scope,digest,{secret:'opaque-private-key'},['opaque-private-key'])).rejects.toThrow('rich_evidence_refused');
  await pg.exec("UPDATE jobs SET customer_id='changed'");
  expect(await readRichArtifact(db,scope.jobId,scope.tenantId,[])).toBeNull();
 });
});
