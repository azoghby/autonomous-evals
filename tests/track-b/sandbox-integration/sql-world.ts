import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { PostgresTextCheckpointStore, type CheckpointKey } from '../../../packages/core/src/evals/integration/checkpoints';
import type { AgentTransactionalSql, AgentSqlExecutor } from '../../../packages/core/src/agents/postgres-ports';
import type { SandboxRun, SandboxRuntime, EnvironmentSpec, SandboxScenario, ToolCallRecord, StateDiff } from '../../../packages/core/src/sandbox/spec';
import type { GateReplayPort } from '../../../packages/core/src/evals/sandbox/generation/gates';

/** Actual PostgreSQL checkpoint transactions; reopened adapters share durable database state. */
export function sqlPort(db: PGlite): AgentTransactionalSql {
  const wrap = (db: {query<T>(sql:string,params?:unknown[]):Promise<{rows:T[]}>}): AgentSqlExecutor => ({query: <T>(sql:string,params?:unknown[])=>db.query<T>(sql,params)});
  return {...wrap(db), transaction: fn => db.transaction(tx=>fn(wrap(tx)))};
}
export async function checkpointDatabase(path?: string) {
  const db = new PGlite(path);
  await db.exec(`CREATE SCHEMA IF NOT EXISTS text_integration;
    CREATE TABLE IF NOT EXISTS text_integration.checkpoints(job_id text NOT NULL,kind text NOT NULL,id text NOT NULL,input_digest text NOT NULL,token text NOT NULL,state text NOT NULL,value jsonb,PRIMARY KEY(job_id,kind,id));`);
  return {db,store:new PostgresTextCheckpointStore(sqlPort(db))};
}
export function gateReplay(store: PostgresTextCheckpointStore): GateReplayPort {
  return {once:async<T>(id:string,inputDigest:string,operation:()=>Promise<T>):Promise<T>=>{
    const key:CheckpointKey={jobId:'sql-gates',kind:'sandbox-gate',id,inputDigest};
    const claim=await store.claim(key);
    if(claim.state==='completed')return claim.value as T;
    if(claim.state!=='claimed')throw Error('pending_reconciliation');
    try {const result=await operation();await store.complete(key,claim.token,result);return result;}
    catch(e){await store.markAmbiguous(key,claim.token);throw e;}
  }};
}
type Rows=Array<Record<string,unknown>>;
const ident=(s:string)=>'"'+s.replaceAll('"','""')+'"';
export class SqlWorld implements SandboxRun {
  readonly runId=randomUUID(); readonly db=new PGlite(); records:ToolCallRecord[]=[];
  baseline=new Map<string,Rows>(); disposed=false;
  private constructor(readonly env:EnvironmentSpec){}
  static async create(env:EnvironmentSpec,scenario:SandboxScenario) {
    const run=new SqlWorld(env);await run.db.exec(env.state.ddl);await run.db.exec(env.state.seedSql);if(scenario.fixtureSql)await run.db.exec(scenario.fixtureSql);
    run.baseline=await run.rows();return run;
  }
  async rows(){const tables=(await this.db.query<{table_name:string}>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows;
    const result=new Map<string,Rows>();for(const {table_name} of tables) result.set(table_name,(await this.db.query(`SELECT * FROM ${ident(table_name)} ORDER BY 1`)).rows as Rows);return result;}
  async query(sql:string):Promise<Rows>{return this.db.transaction(async tx=>{await tx.exec('SET TRANSACTION READ ONLY');await tx.exec("SET LOCAL statement_timeout='1000ms'");return (await tx.query(sql)).rows as Rows;});}
  async callTool(name:string,args:unknown):Promise<ToolCallRecord>{
    const record:ToolCallRecord={seq:this.records.length+1,tool:name,args:structuredClone(args),result:null,ms:0};
    try {const tool=this.env.tools.find(t=>t.name===name);if(!tool||tool.binding.kind!=='sql')throw Error('unsupported fixture tool');
      if(JSON.stringify(args)!=='{}')throw Error('fixture tools have no parameters');
      const results=[];for(const sql of tool.binding.statements)results.push(await this.db.query(sql));record.result=results[tool.binding.resultFrom??results.length-1]?.rows;
    }catch{record.error='fixture_tool_error';}this.records.push(record);return structuredClone(record);
  }
  async diff():Promise<StateDiff[]>{const after=await this.rows(),diff:StateDiff[]=[];
    for(const table of new Set([...this.baseline.keys(),...after.keys()])){const before=this.baseline.get(table)??[],now=after.get(table)??[];
      const same=(a:Record<string,unknown>,b:Record<string,unknown>)=>JSON.stringify(a)===JSON.stringify(b);
      const removed=before.filter(a=>!now.some(b=>same(a,b))),added=now.filter(a=>!before.some(b=>same(a,b)));
      if(removed.length||added.length)diff.push({table,inserted:added.length,deleted:removed.length,updated:0,sample:structuredClone(added)});
    }return diff;}
  async outbox(){return [];}
  trajectory(){return structuredClone(this.records);}
  async fork(scenario:SandboxScenario){const fork=await SqlWorld.create(this.env,scenario);const rows=await this.rows();
    for(const [table,values]of rows){await fork.db.exec(`DELETE FROM ${ident(table)}`);for(const row of values){const keys=Object.keys(row);await fork.db.query(`INSERT INTO ${ident(table)} (${keys.map(ident).join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));}}
    fork.records=structuredClone(this.records);return fork;}
  /** Logical runtime disposal keeps a private final snapshot available to the integration grader. */
  async dispose(){this.disposed=true;}
  async close(){await this.db.close();}
}
export class SqlRuntime implements SandboxRuntime {
  runs:SqlWorld[]=[]; worlds=new Set<string>(); snapshots=new Map<string,SqlWorld>();
  async prepare(_env:EnvironmentSpec,jobId:string){this.worlds.add(jobId);return{worldId:jobId};}
  async startRun(worldId:string,env:EnvironmentSpec,scenario:SandboxScenario){if(!this.worlds.has(worldId))throw Error('unknown_world');const run=await SqlWorld.create(env,scenario);this.runs.push(run);const dispose=run.dispose.bind(run);run.dispose=async()=>{if(!this.snapshots.has(run.runId))this.snapshots.set(run.runId,await run.fork(scenario));await dispose();};return run;}
  async teardown(worldId:string){this.worlds.delete(worldId);}
  async close(){for(const run of this.runs)await run.close();for(const snapshot of this.snapshots.values())if(!snapshot.disposed)await snapshot.close();}
}
