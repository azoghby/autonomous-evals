/** Offline ports only: these results cannot authorize hosted acceptance. */
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { executeSuite, evaluateObjectiveCheck } from '@ae/core/evals/text';
import { verifyAdmittedFrozenSuite } from '@ae/core/evals/text/freeze';
import { createTextTarget } from '@ae/core/targets/text';
import { POST } from '@/app/api/internal/track-b-remediation/chat/completions/route';

it('retains exact accepted frozen12 baseline and trial with all48 fake-provider rubric observations and actual local SQL records',async()=>{
 const stage=process.env.WORKFLOW_STAGE!;
 const artifact=JSON.parse(readFileSync(join(stage,'packages/core/src/evals/text/__tests__/evidence/text-design-v3-2026-11-07.json'),'utf8'));
 const suite=verifyAdmittedFrozenSuite(artifact.outcome.suite), frozen=JSON.stringify(suite);
 expect(suite.digest).toBe('0e5d6df16cd4c5953bb3a0966cf410216690549d3393cf60150d30b711a942e9');
 expect(suite.scenarios).toHaveLength(12);
 const patch=suite.systemPrompt+'\nUse literal reference answers and preserve every constraint.';
 const token='offline-test-only-independent-fixture-authority';
 const saved=[process.env.TRACK_B_ACCEPTANCE_TOKEN,process.env.TRACK_B_REMEDIATION_PATCH_SHA256];
 const db=new PGlite();let calls=0,judgments=0;
 try{
  process.env.TRACK_B_ACCEPTANCE_TOKEN=token;
  process.env.TRACK_B_REMEDIATION_PATCH_SHA256=createHash('sha256').update(patch).digest('hex');
  await db.exec('CREATE TABLE observations(run_id text,scenario_id text,body jsonb,PRIMARY KEY(run_id,scenario_id));');
  const target=createTextTarget({url:'https://fixture.invalid/api/internal/track-b-remediation/chat/completions',model:'track-b-lumen-remediation-v1',apiKey:token,maxCompletionTokens:512},{post:async(url,body,bearer)=>{
   calls++;expect(bearer).toBe(token);
   const response=await POST(new Request(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}));
   expect(response.status).toBe(200);const value=await response.json();expect(value.usage).toBeUndefined();return value;
  }});
  const runs=[];
  for(const phase of ['baseline','trial']){
   // Preserve the admitted suite; the trial transport receives reviewed system bytes.
   const port={send:async(request:any)=>target.send({...request,systemPrompt:phase==='trial'?patch:request.systemPrompt})};
   const run=await executeSuite(suite,phase,{target:port,evaluateObjective:evaluateObjectiveCheck,judge:async()=>{
    judgments++;return {outcome:'inconclusive' as const,explanation:'Offline fake provider observation; no real Gateway verdict.',evidenceQuotes:[]};
   }});
   expect(run.executions).toHaveLength(12);
   for(const row of run.executions)await db.query('INSERT INTO observations VALUES($1,$2,$3)',[phase,row.scenarioId,JSON.stringify(row)]);
   runs.push(run);
  }
  expect(calls).toBe(24);expect(judgments).toBe(48);expect(JSON.stringify(suite)).toBe(frozen);
  const objectiveFailures=(r:any)=>r.executions.flatMap((e:any)=>e.checks).filter((c:any)=>c.kind==='objective'&&c.status==='fail');
  expect(objectiveFailures(runs[0])).toHaveLength(1);expect(objectiveFailures(runs[1])).toHaveLength(0);
  expect((await db.query('SELECT * FROM observations')).rows).toHaveLength(24);
  for(const run of runs)expect(run.executions.flatMap(e=>e.checks).filter(c=>c.kind==='rubric').every(c=>c.status!=='pass')).toBe(true);
  // A duplicate observation cannot overwrite independently retained execution facts.
  await expect(db.query('INSERT INTO observations SELECT * FROM observations LIMIT 1')).rejects.toThrow();
  expect(calls).toBe(24);
 }finally{
  for(const [i,key] of ['TRACK_B_ACCEPTANCE_TOKEN','TRACK_B_REMEDIATION_PATCH_SHA256'].entries())if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];
  await db.close();
 }
},60000);
