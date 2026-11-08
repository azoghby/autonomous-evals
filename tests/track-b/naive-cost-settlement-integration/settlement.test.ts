import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { settleCost, type CostSql, type CostTransaction } from '../../../packages/core/src/db/cost-settlement';
import { CostEntry } from '../../../packages/core/src/contracts/index';
vi.mock('@neondatabase/serverless',()=>({Pool:class { async connect(){return {query:(q:string,p?:unknown[])=>pg.query(q,p),release:()=>{}};} }}));
vi.mock('@ae/core/db/client',()=>({db:()=>{throw Error('unexpected legacy database sink');},schema:{sandboxEnvironments:{},sandboxSuites:{},sandboxRuns:{}}}));
vi.mock('@ae/core/adapters/index',()=>({createServiceAdapters:()=>({})}));
vi.mock('@ae/core/storage/crypto',()=>({decryptJson:()=>{throw Error('unused');}}));
vi.mock('@ae/core/storage/blob',()=>({readJobArtifactText:()=>{throw Error('unused');}}));
vi.mock('@/server/intake',()=>({injectCredentials:()=>{throw Error('unused');}}));
const owner='123e4567-e89b-42d3-a456-426614174000', other='123e4567-e89b-42d3-a456-426614174001';
const job='123e4567-e89b-42d3-a456-426614174002', job2='123e4567-e89b-42d3-a456-426614174003';
const session='ses_'+'0'.repeat(26);
const request='req_'+'0'.repeat(26);
let pg:PGlite, path:string;
const txPort=(tx:Pick<PGlite,'query'>):CostTransaction=>({query:(text,params)=>tx.query(text,params)});
const database=():CostSql=>({transaction:fn=>pg.transaction(tx=>fn(txPort(tx)))});
const naive=(extra:Record<string,unknown>={})=>({source:'naive',sessionId:session,agent:'engineer',microUsd:31,meta:{measured:true,purpose:'design',idempotencyKey:`naive:${session}`},...extra});
const proxy=(extra:Record<string,unknown>={})=>({source:'naive_proxy',requestId:request,agent:'judge',microUsd:7,meta:{measured:true,purpose:'rubric',idempotencyKey:`naive_proxy:${request}`},...extra});
const target={kind:'job' as const,id:job,ownerId:owner,environment:'test' as const};
async function rows(){return (await pg.query<{micro_usd:number;receipt_key:string|null}>('SELECT micro_usd,receipt_key FROM costs ORDER BY created_at')).rows;}
async function total(kind:'run'|'suite',id:string){return Number((await pg.query<{cost_micro_usd:number}>(`SELECT cost_micro_usd FROM sandbox_${kind==='run'?'runs':'suites'} WHERE id=$1`,[id])).rows[0].cost_micro_usd);}
beforeAll(async()=>{
 path=await mkdtemp(join(tmpdir(),'naive-cost-db-'));pg=new PGlite(path);
 const dir=new URL('../../../packages/core/src/db/migrations/',import.meta.url);
 const journal=JSON.parse(readFileSync(new URL('meta/_journal.json',dir),'utf8')) as {entries:{tag:string}[]};
 for(const e of journal.entries)await pg.exec(readFileSync(new URL(e.tag+'.sql',dir),'utf8'));
 await pg.query('INSERT INTO customers(id,email) VALUES($1,$2),($3,$4)',[owner,'owner@example.test',other,'other@example.test']);
 await pg.query("INSERT INTO jobs(id,customer_id,package,intake) VALUES($1,$2,'text_eval','{}'),($3,$2,'text_eval','{}')",[job,owner,job2]);
 await pg.query("INSERT INTO sandbox_environments(id,owner_id,name,source,spec) VALUES('env-one',$1,'one','custom','{}'),('env-two',$1,'two','custom','{}')",[owner]);
 await pg.query("INSERT INTO sandbox_suites(id,owner_id,environment_id,budget_micro_usd) VALUES('suite-one',$1,'env-one',1000),('suite-two',$1,'env-two',1000)",[owner]);
 await pg.query("INSERT INTO sandbox_runs(id,owner_id,environment_id,k,scenarios,budget_micro_usd,trials_total) VALUES('run-one',$1,'env-one',1,'[]',1000,1)",[owner]);
});
beforeEach(async()=>{
 await pg.exec('DELETE FROM costs; UPDATE sandbox_suites SET cost_micro_usd=0; UPDATE sandbox_runs SET cost_micro_usd=0;');
 await pg.query("UPDATE jobs SET customer_id=$1,environment='test'",[owner]);
 await pg.query("UPDATE sandbox_suites SET owner_id=$1,environment_id=CASE WHEN id='suite-one' THEN 'env-one' ELSE 'env-two' END",[owner]);
});
afterAll(async()=>{await pg?.close();if(path)await rm(path,{recursive:true,force:true});});
describe('applied owner settlement source on PostgreSQL/PGlite',()=>{
 it('settles concurrent identical job delivery once',async()=>{
  const result=await Promise.all(Array.from({length:12},()=>settleCost(database(),target,naive())));
  expect(result.filter(x=>x.inserted)).toHaveLength(1);expect(await rows()).toHaveLength(1);
 });
 it('settles suite and run aggregates exactly once, including zero',async()=>{
  for(const kind of ['suite','run'] as const){
   const id=kind+'-one',entry=kind==='suite'?naive():proxy({microUsd:0});
   const result=await Promise.all([settleCost(database(),{kind,id,ownerId:owner},entry),settleCost(database(),{kind,id,ownerId:owner},entry)]);
   expect(result.filter(x=>x.inserted)).toHaveLength(1);expect(await total(kind,id)).toBe(kind==='suite'?31:0);
  }expect(await rows()).toHaveLength(2);
 });
 it('replays after committed settlement loses acknowledgement and database reopens',async()=>{
  const lossy:CostSql={transaction:async fn=>{await database().transaction(fn);throw Error('lost acknowledgement');}};
  await expect(settleCost(lossy,{kind:'suite',id:'suite-one'},naive())).rejects.toThrow('lost acknowledgement');
  await pg.close();pg=new PGlite(path);
  expect((await settleCost(database(),{kind:'suite',id:'suite-one'},naive())).inserted).toBe(false);
  expect(await rows()).toHaveLength(1);expect(await total('suite','suite-one')).toBe(31);
 });
 it('rejects altered owner, amount, purpose, agent and cross-job reuse',async()=>{
  await settleCost(database(),target,naive());
  for(const e of [naive({microUsd:32}),naive({agent:'investigator'}),naive({meta:{measured:true,purpose:'different'}})])await expect(settleCost(database(),target,e)).rejects.toThrow();
  await expect(settleCost(database(),{...target,id:job2},naive())).rejects.toThrow();
  await expect(settleCost(database(),{...target,ownerId:other},naive())).rejects.toThrow();
  expect(await rows()).toHaveLength(1);
 });
 it('rechecks canonical owner/environment before accepting a stored replay',async()=>{
  await settleCost(database(),target,naive());
  await pg.query("UPDATE jobs SET environment='live' WHERE id=$1",[job]);
  await expect(settleCost(database(),target,naive())).rejects.toThrow();
  await expect(settleCost(database(),{...target,environment:'live'},naive())).rejects.toThrow();
  await pg.query("UPDATE jobs SET environment='test',customer_id=$2 WHERE id=$1",[job,other]);
  await expect(settleCost(database(),{...target,ownerId:other},naive())).rejects.toThrow();
  expect(await rows()).toHaveLength(1);
 });
 it('rejects changed sandbox environment and cross-target receipt reuse',async()=>{
  const t={kind:'suite' as const,id:'suite-one'};await settleCost(database(),t,naive());
  await expect(settleCost(database(),{kind:'suite',id:'suite-two'},naive())).rejects.toThrow();
  await pg.exec("UPDATE sandbox_suites SET environment_id='env-two' WHERE id='suite-one'");
  await expect(settleCost(database(),t,naive())).rejects.toThrow();
  expect(await total('suite','suite-one')).toBe(31);expect(await total('suite','suite-two')).toBe(0);
 });
 it('rolls back inserted receipt when aggregate update fails, then retry settles once',async()=>{
  const failing:CostSql={transaction:fn=>pg.transaction(tx=>fn({query:async <T>(q:string,p?:unknown[])=>{if(/^\s*UPDATE\s+"?sandbox_suites/i.test(q))throw Error('aggregate failure');return tx.query<T>(q,p);}}))};
  await expect(settleCost(failing,{kind:'suite',id:'suite-one'},naive())).rejects.toThrow('aggregate failure');
  expect(await rows()).toHaveLength(0);expect(await total('suite','suite-one')).toBe(0);
  await settleCost(database(),{kind:'suite',id:'suite-one'},naive());expect(await total('suite','suite-one')).toBe(31);
 });
 it('rejects unknown billing and malformed numeric or provider identities',async()=>{
  for(const e of [naive({sessionId:undefined}),naive({microUsd:-1}),naive({microUsd:.5}),naive({microUsd:Number.MAX_SAFE_INTEGER+1}),naive({meta:{measured:false,purpose:'design'}}),naive({meta:{measured:true,purpose:'design',idempotencyKey:'wrong'}}),proxy({requestId:undefined})])await expect(settleCost(database(),target,e)).rejects.toThrow();
  expect(await rows()).toHaveLength(0);
 });
 it('retains distinct provider receipts and leaves gateway calls unkeyed',async()=>{
  await settleCost(database(),target,proxy());
  const second=request.replace(/.$/,'v');await settleCost(database(),target,proxy({requestId:second,meta:{measured:true,purpose:'rubric',idempotencyKey:`naive_proxy:${second}`}}));
  const gateway={source:'ai_gateway',microUsd:3,meta:{model:'test'}};
  await settleCost(database(),target,gateway);await settleCost(database(),target,gateway);
  expect(await rows()).toHaveLength(4);expect((await rows()).filter(x=>x.receipt_key===null)).toHaveLength(2);
 });
 it('refuses to double-charge a matching historical unkeyed Naive row',async()=>{
  await pg.query("INSERT INTO costs(job_id,source,agent,session_id,micro_usd,meta) VALUES($1,'naive','engineer',$2,31,'{}')",[job,session]);
  await expect(settleCost(database(),target,naive())).rejects.toThrow();expect(await rows()).toHaveLength(1);
 });

 it('routes the actual job and sandbox sinks through settlement SQL',async()=>{
  vi.stubEnv('DATABASE_URL_UNPOOLED','postgres://local-test-only');
  // Runtime imports keep this isolated helper typecheck honest: this is source execution,
  // not a claim that the full application graph has passed TypeScript/build.
  const jobPath=join(process.cwd(),'apps/web/src/server/job-store.ts');
  const sandboxPath=join(process.cwd(),'apps/web/src/server/sandbox/store.ts');
  const jobs=await import(jobPath);const sandbox=await import(sandboxPath);
  await jobs.recordCost({...naive(),jobId:job},{ownerId:owner,environment:'test'});
  await jobs.recordCost({...naive(),jobId:job},{ownerId:owner,environment:'test'});
  const store=sandbox.createDbSandboxStore();
  await store.addCost({kind:'suite',id:'suite-one'},proxy());
  await store.addCost({kind:'suite',id:'suite-one'},proxy());
  expect(await rows()).toHaveLength(2);expect(await total('suite','suite-one')).toBe(7);
  vi.unstubAllEnvs();
 });
 it('keeps actual sandbox step budget unchanged on replay or rejected settlement',async()=>{
  vi.stubEnv('DATABASE_URL_UNPOOLED','postgres://local-test-only');
  const sandbox=await import(join(process.cwd(),'apps/web/src/server/sandbox/store.ts'));
  const ctx=sandbox.stepBudgetContext(sandbox.createDbSandboxStore(),{kind:'suite',id:'suite-one'},100,0);
  await ctx.recordCost(proxy());expect(ctx.budgetMicroUsd).toBe(93);
  await ctx.recordCost(proxy());expect(ctx.budgetMicroUsd).toBe(93);
  await expect(ctx.recordCost(proxy({microUsd:8}))).rejects.toThrow();expect(ctx.budgetMicroUsd).toBe(93);
  const restarted=sandbox.stepBudgetContext(sandbox.createDbSandboxStore(),{kind:'suite',id:'suite-one'},100,7);
  await restarted.recordCost(proxy());expect(restarted.budgetMicroUsd).toBe(93);
  expect(await total('suite','suite-one')).toBe(7);vi.unstubAllEnvs();
 });
 it('accepts the proxy contract without pretending request IDs are sessions',()=>{
  const parsed=CostEntry.parse({...proxy(),jobId:job});expect(parsed.source).toBe('naive_proxy');expect(parsed.requestId).toBe(request);expect(parsed.sessionId).toBeUndefined();
 });
});
