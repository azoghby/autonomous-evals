import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { createSandboxRun } from '../../../packages/core/src/sandbox/runtime/run';
import { WORLD_PREAMBLE_SQL, snapshotBaseline } from '../../../packages/core/src/sandbox/runtime/world-sql';
import type { SqlConn } from '../../../packages/core/src/sandbox/runtime/types';
import type { SandboxRuntime, EnvironmentSpec, SandboxScenario } from '../../../packages/core/src/sandbox/spec';
import { retainRuntimeRun, capturePGliteImage } from '../../../packages/core/src/evals/sandbox/runtime-bridge';
import { executionDigest, type TrialInput } from '../../../packages/core/src/evals/sandbox/execution/runner';

/** Actual A tool executor, independent SQL world and concrete retained data-directory image.
 * Registry is deliberately local; durable report replay is tested separately in PostgreSQL. */
export class ActualMediaRuntime implements SandboxRuntime {
 input!: TrialInput;
 handles = new Map<string, Awaited<ReturnType<typeof retainRuntimeRun>>>();
 disposed = new Set<string>();
 tools = 0;
 worlds = new Set<string>();
 constructor(readonly events: string[]) {}
 async prepare(_env: EnvironmentSpec, key: string) { this.worlds.add(key); return { worldId: key }; }
 async startRun(worldId: string, env: EnvironmentSpec, scenario: SandboxScenario) {
  if (!this.worlds.has(worldId)) throw Error('unknown_world');
  this.events.push('allocate');
  const db = new PGlite();
  const conn: SqlConn = { query: async (sql, params=[]) => { const r=await db.query(sql,params); return { rows:r.rows as never[],rowCount:r.affectedRows??r.rows.length }; },exec:async sql=>{await db.exec(sql);},close:()=>db.close() };
  let raw: ReturnType<typeof createSandboxRun> | undefined;
  try {
   await db.exec(WORLD_PREAMBLE_SQL);await db.exec(env.state.ddl);await db.exec(env.state.seedSql);
   if(scenario.fixtureSql)await db.exec(scenario.fixtureSql);await snapshotBaseline(conn);
   raw=createSandboxRun({runId:randomUUID(),conn,env,scenario});
   const original=raw.callTool;raw.callTool=async(name,args)=>{this.tools++;return original(name,args);};
   const input=structuredClone(this.input);
   const handle=await retainRuntimeRun({run:raw,binding:{worldId,executionIdentity:executionDigest(input),environment:env,scenario,versions:input.versions},
    issuePolicy:async request=>({...request,policyId:'approved-read-only-no-mutations',allowed:[]}),capture:()=>capturePGliteImage(db)});
   this.handles.set(raw.runId,handle);
   const dispose=handle.run.dispose;handle.run.dispose=async()=>{this.events.push('dispose');try{await dispose();}finally{this.disposed.add(handle.run.runId);}};
   return handle.run;
  }catch(e){if(raw)await raw.dispose();else await db.close();throw e;}
 }
 async teardown(worldId:string){this.worlds.delete(worldId);}
 async close(){for(const handle of this.handles.values()){await handle.run.dispose();await handle.forget();}}
}
