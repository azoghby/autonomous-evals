import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { connection, storage, binding, policy, environment, scenario } from './helpers';
import { createDurableRuntimeComposition } from '../../../packages/core/src/evals/sandbox/runtime-composition';
import { createSandboxRun } from '../../../packages/core/src/sandbox/runtime/run';
import { WORLD_PREAMBLE_SQL, snapshotBaseline } from '../../../packages/core/src/sandbox/runtime/world-sql';
import type { SqlConn } from '../../../packages/core/src/sandbox/runtime/types';
import { gradeSandbox } from '../../../packages/core/src/evals/sandbox/grading';
it('composes actual runtime quiescence, single dump and durable finalSnapshot',async()=>{
 const c=connection(),db=new PGlite();let dumps=0;
 const conn:SqlConn={query:async(sql,params=[])=>{const r=await db.query(sql,params);return {rows:r.rows as never[],rowCount:r.affectedRows??r.rows.length};},exec:async sql=>{await db.exec(sql);},close:()=>db.close()};
 try {
  await db.exec(WORLD_PREAMBLE_SQL);await db.exec(environment.state.ddl);await db.exec(environment.state.seedSql);await snapshotBaseline(conn);
  const b=binding('composed-restart'),raw=createSandboxRun({runId:b.runId,conn,env:environment,scenario});
  const s=storage(c.db),composition=createDurableRuntimeComposition({storage:s,resolvePolicy:async r=>policy(r),synchronousReadGuard:()=>true});
  const retained=await composition.retain({run:{...raw,exec:async(sql:string)=>{await db.exec(sql);}},binding:{...b,environment,scenario},source:{dumpDataDir:async()=>{dumps++;return db.dumpDataDir();}}});
  await retained.run.exec!("UPDATE hidden.entries SET value='approved'");
  const artifact={runId:b.runId,worldId:b.worldId,identityDigest:b.executionIdentity,input:{environment,scenario,versions:b.versions},diff:await retained.run.diff(),toolCalls:retained.run.trajectory(),outbox:await retained.run.outbox()};
  await retained.run.dispose(); expect(dumps).toBe(1);
  const snapshot=await composition.finalSnapshot(artifact);expect(snapshot).not.toBeNull();expect(snapshot!.evidence.completeDiff?.snapshotId).toBe((await s.get(b))!.record.snapshotId);
  try{const grade=await gradeSandbox({...snapshot!.evidence,run:snapshot!.run,scenario,versions:b.versions,transcript:[]});expect(grade.checks.find(c=>c.id==='collateral')?.verdict).toBe('pass');}finally{await snapshot!.release();}
  expect(dumps).toBe(1);await writeFile(process.env.COMPOSITION_ARTIFACT!,JSON.stringify(artifact));await retained.forget();const afterForget=await composition.finalSnapshot(artifact);expect(afterForget.run.runId).toBe(b.runId);await afterForget.release();
 }finally{if(!db.closed)await db.close();await c.close();}
});
