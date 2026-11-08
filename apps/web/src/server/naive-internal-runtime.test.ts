import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { internalMcpDependencies, internalTaskDependencies, internalRuntimeConfig, failClosedInternalLimiter } from './naive-internal-runtime';
import { createInternalTaskApi } from './naive-internal-task-api';
import { createInternalMcpHandler } from './naive-internal-mcp';
import type { AgentSqlExecutor, AgentTransactionalSql } from './naive-internal-store';
const customer='10000000-0000-4000-8000-000000000001', other='10000000-0000-4000-8000-000000000002',job='2a000000-0000-4000-8000-000000000001',credentialId='30000000-0000-4000-8000-000000000001',requestId='4b000000-0000-4000-8000-000000000001';
const bearer='test-only-bearer-value-not-a-real-secret', secret='test-only-task-signing-secret-32-bytes-long';
const config={pin:{agentId:`agt_${'0'.repeat(26)}`,agentVersion:1},secret,audience:'https://example.test/api/mcp/internal/mcp'};
const dbs:PGlite[]=[];afterEach(async()=>{for(const db of dbs.splice(0))await db.close();});
async function fixture(){
 const pg=new PGlite();dbs.push(pg);
 await pg.exec(`CREATE TYPE environment AS ENUM ('test','live'); CREATE TABLE customers(id uuid PRIMARY KEY); CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,environment environment,state text,updated_at timestamptz);
 CREATE TABLE progress_events(id uuid,job_id uuid,milestone text,created_at timestamptz); CREATE TABLE findings(id uuid,job_id uuid,data jsonb,created_at timestamptz);
 CREATE TABLE costs(id uuid,job_id uuid,source text,micro_usd bigint,created_at timestamptz); CREATE TABLE rate_limits(key text PRIMARY KEY,window_start timestamptz,count int);`);
 await pg.exec(readFileSync('docs/naive-internal-mcp-integration/sql/001-internal-mcp.sql','utf8'));
 await pg.query('INSERT INTO customers VALUES($1),($2)',[customer,other]);await pg.query("INSERT INTO jobs VALUES($1,$2,'test','running',now())",[job,customer]);
 await pg.query("INSERT INTO naive_internal.credentials(id,role,agent_id,agent_version,bearer_sha256) VALUES($1,'copilot',$2,1,$3)",[credentialId,config.pin.agentId,createHash('sha256').update(bearer).digest('hex')]);
 const db:AgentTransactionalSql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(t=>fn({query:(q,p)=>t.query(q,p)} as AgentSqlExecutor))};
 const api=createInternalTaskApi(internalTaskDependencies(db,config,async()=>customer));const handle=createInternalMcpHandler(internalMcpDependencies(db,config));
 return {pg,db,api,handle};
}
function issueRequest(body:unknown,headers:Record<string,string>={}){return new Request(`https://example.test/api/jobs/${job}/naive-copilot-task`,{method:'POST',headers:{origin:'https://example.test','content-type':'application/json',...headers},body:JSON.stringify(body)});}
function toolRequest(token:string,key=bearer){return new Request(config.audience,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_progress_snapshot',arguments:{task_token:token}}})});}
async function rpc(response:Response){const text=await response.text();return response.headers.get('content-type')?.includes('text/event-stream')?text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6))).find(r=>r.id===1):JSON.parse(text);}
it('issues through owner API, reads through real MCP transport, replays exactly and revokes future reads',async()=>{
 const f=await fixture();expect((await f.api(issueRequest({action:'revoke',taskId:requestId}),job)).status).toBe(503);const first=await f.api(issueRequest({action:'issue',requestId:requestId.toUpperCase()}),job.toUpperCase());expect(first.status).toBe(200);expect(first.headers.get('cache-control')).toBe('private, no-store');const issued=await first.json();
 expect(await (await f.api(issueRequest({action:'issue',requestId}),job)).json()).toEqual(issued);
 const result=await rpc(await f.handle(toolRequest(issued.taskToken)));expect(JSON.parse(result.result.content[0].text)).toMatchObject({jobId:job,status:'running',unknownCosts:true});
 const stored=JSON.stringify((await f.pg.query('SELECT * FROM naive_internal.tasks')).rows);expect(stored).not.toContain(issued.taskToken);expect(stored).not.toContain(bearer);
 expect((await f.api(issueRequest({action:'revoke',taskId:issued.taskId}),job)).status).toBe(200);
 const denied=await rpc(await f.handle(toolRequest(issued.taskToken)));expect(denied.result.isError).toBe(true);expect(JSON.stringify(denied)).not.toContain(job);
 expect((await f.api(issueRequest({action:'issue',requestId}),job)).status).toBe(503);
 const outcomes=(await f.pg.query<{outcome:string}>('SELECT outcome FROM naive_internal.audit')).rows.map(r=>r.outcome);expect(outcomes).toEqual(['task_issued','task_replayed','read_allowed','task_revoked','read_denied']);
});
it('rejects foreign ownership, credential revocation and forged/customer bearer at production composition',async()=>{
 const f=await fixture();const issued=await (await f.api(issueRequest({action:'issue',requestId}),job)).json();
 expect((await f.handle(toolRequest(issued.taskToken,'ae_customer_api_key_from_other_surface'))).status).toBe(401);
 await f.pg.query('UPDATE jobs SET customer_id=$1 WHERE id=$2',[other,job]);expect((await rpc(await f.handle(toolRequest(issued.taskToken)))).result.isError).toBe(true);
 await f.pg.query('UPDATE jobs SET customer_id=$1 WHERE id=$2',[customer,job]);await f.pg.query('UPDATE naive_internal.credentials SET revoked_at=now() WHERE id=$1',[credentialId]);expect((await f.handle(toolRequest(issued.taskToken))).status).toBe(401);
});
it('fails closed on real limiter SQL outage and on missing audit persistence',async()=>{
 const f=await fixture();const issued=await (await f.api(issueRequest({action:'issue',requestId}),job)).json();
 await f.pg.exec('DROP TABLE rate_limits');expect((await f.handle(toolRequest(issued.taskToken))).status).toBe(503);expect((await f.api(issueRequest({action:'issue',requestId}),job)).status).toBe(503);
 await f.pg.exec('CREATE TABLE rate_limits(key text PRIMARY KEY,window_start timestamptz,count int)');await f.pg.exec("CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private DB detail'; END $$; CREATE TRIGGER reject_audit BEFORE INSERT ON naive_internal.audit FOR EACH ROW EXECUTE FUNCTION reject_audit();");
 const failed=await rpc(await f.handle(toolRequest(issued.taskToken)));expect(failed.result.isError).toBe(true);expect(JSON.stringify(failed)).not.toMatch(/private DB detail|jobId|task_token/);
});
it('limiter enforces and isolates the stored window rather than returning success on invalid rows',async()=>{const f=await fixture(),limit=failClosedInternalLimiter(f.db);expect((await limit('scope1',1,600)).ok).toBe(true);expect((await limit('scope1',1,600)).ok).toBe(false);expect((await limit('scope2',1,600)).ok).toBe(true);await f.pg.query("UPDATE rate_limits SET window_start=now()-interval '601 seconds' WHERE key='scope1'");expect((await limit('scope1',1,600)).ok).toBe(true);});
it('requires fresh owner, same-origin, exact bounded body and explicit runtime configuration',async()=>{
 const f=await fixture();expect((await f.api(issueRequest({action:'issue',requestId},{origin:'https://other.test'}),job)).status).toBe(403);
 expect((await f.api(issueRequest({action:'issue',requestId,customerId:other}),job)).status).toBe(400);
 expect((await f.api(issueRequest({action:'issue',requestId,large:'x'.repeat(3000)}),job)).status).toBe(413);
 const viewer=vi.fn().mockResolvedValueOnce(customer).mockResolvedValue(null);const api=createInternalTaskApi(internalTaskDependencies(f.db,config,viewer));expect((await api(issueRequest({action:'issue',requestId}),job)).status).toBe(503);expect((await f.pg.query('SELECT * FROM naive_internal.tasks')).rows).toHaveLength(0);
 expect(()=>internalRuntimeConfig({})).toThrow();expect(internalRuntimeConfig({NAIVE_INTERNAL_MCP_ENABLED:'1',NAIVE_AGENT_COPILOT:`${config.pin.agentId}@1`,NAIVE_TASK_TOKEN_SECRET:secret,APP_URL:'https://example.test'})).toEqual(config);
});
