import {it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {createSandboxRun} from '../packages/core/src/sandbox/runtime/run';
import {WORLD_PREAMBLE_SQL,clockSql,snapshotBaseline} from '../packages/core/src/sandbox/runtime/world-sql';
import {tinyEnv,tinyScenario,TINY_DDL,TINY_SEED} from '../packages/core/src/sandbox/runtime/__fixtures__/tiny-env';
import type {SqlConn} from '../packages/core/src/sandbox/runtime/types';
async function fixture(){
 const db=new PGlite();
 const conn:SqlConn={query:async(sql,params=[])=>{const r=await db.query(sql,params);return {rows:r.rows as never[],rowCount:r.affectedRows??r.rows.length};},exec:async sql=>{await db.exec(sql);},close:async()=>{}};
 await db.exec(WORLD_PREAMBLE_SQL);const clock=clockSql('2026-06-01T15:00:00Z');await conn.query(clock.text,clock.values);await db.exec(TINY_DDL);await db.exec(TINY_SEED);await snapshotBaseline(conn);
 const run=createSandboxRun({runId:'parameter-fixture',conn,env:tinyEnv(),scenario:tinyScenario()});
 return {db,run};
}
it('forwards bound positional query values without interpreting SQL-shaped data',async()=>{
 const {db,run}=await fixture();try{
  const value="x'; DROP TABLE customers; --";
  expect(await run.query('SELECT $1::text AS value',[value])).toEqual([{value}]);
  expect((await run.query('SELECT count(*)::int AS count FROM customers'))[0].count).toBeGreaterThan(0);
 }finally{await run.dispose();await db.close();}
});
it('snapshots nested parameters before serialized asynchronous reads',async()=>{
 const {db,run}=await fixture();try{
  const params=[{value:'original'}];
  const pending=run.query('SELECT $1::jsonb AS payload',params);
  params[0].value='changed';
  expect(await pending).toEqual([{payload:{value:'original'}}]);
 }finally{await run.dispose();await db.close();}
});
it('preserves read-only rejection and parameterless query compatibility',async()=>{
 const {db,run}=await fixture();try{
  await expect(run.query('DELETE FROM customers WHERE id=$1',['cus_1'])).rejects.toThrow();
  expect(await run.query('SELECT true AS ok')).toEqual([{ok:true}]);
 }finally{await run.dispose();await db.close();}
});
