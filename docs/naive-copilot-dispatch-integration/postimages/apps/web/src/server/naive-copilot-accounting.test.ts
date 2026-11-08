import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { createPostgresConversationPort } from '@ae/core/reporting/chat/postgres-conversations';
import type { AgentSqlExecutor } from '@ae/core/agents/postgres-ports';
import type { NaiveSessionSnapshot } from '@ae/core/evals/types';
import { issueTask } from './naive-internal-store';
import { mintTaskToken } from './naive-internal-token';
import { readInternalProgress } from './naive-internal-progress';
import { CopilotDispatchStore } from './naive-copilot-store';
import { copilotCreateBody, dispatchCopilot } from './naive-copilot-dispatch';
import { deliverCopilotCost } from './naive-copilot-accounting';

const databases:PGlite[]=[];
afterEach(async()=>{await Promise.all(databases.splice(0).map(db=>db.close()));});
const customer='10000000-0000-4000-8000-000000000001',job='20000000-0000-4000-8000-000000000001';
const credential='30000000-0000-4000-8000-000000000001',turn='40000000-0000-4000-8000-000000000001';
const pin={agentId:'agt_'+'a'.repeat(26),agentVersion:1};
const session='ses_'+'a'.repeat(26),question='What is the status?';
async function fixture(){
 const pg=new PGlite();databases.push(pg);
 await pg.exec(`CREATE TYPE environment AS ENUM ('test','live');
 CREATE TABLE customers(id uuid PRIMARY KEY);
 CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid REFERENCES customers(id),environment environment,state text NOT NULL DEFAULT 'running',updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE costs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid REFERENCES jobs(id),source text NOT NULL,agent text,session_id text,micro_usd bigint NOT NULL,meta jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE progress_events(id uuid PRIMARY KEY,job_id uuid,milestone text,created_at timestamptz);
 CREATE TABLE findings(id uuid PRIMARY KEY,job_id uuid,data jsonb,created_at timestamptz);`);
 for(const path of ['packages/core/src/agents/persistence-migrations/001-agent-persistence.sql','packages/core/src/db/migrations/0023_cost_receipts.sql','packages/core/src/reporting/chat/persistence-migrations/001-conversations.sql','docs/naive-internal-mcp-integration/sql/001-internal-mcp.sql','docs/naive-copilot-dispatch-integration/sql/001-copilot-dispatch.sql'])await pg.exec(readFileSync(path,'utf8'));
 await pg.query('INSERT INTO customers VALUES($1)',[customer]);
 await pg.query("INSERT INTO jobs(id,customer_id,environment) VALUES($1,$2,'test')",[job,customer]);
 await pg.query("INSERT INTO naive_internal.credentials(id,role,agent_id,agent_version,bearer_sha256) VALUES($1,'copilot',$2,1,$3)",[credential,pin.agentId,'a'.repeat(64)]);
 const db={query:async<T>(sql:string,args?:unknown[])=>({rows:(await pg.query<T>(sql,args)).rows}),transaction:<T>(fn:(tx:AgentSqlExecutor)=>Promise<T>)=>pg.transaction(async tx=>fn({query:async<T>(sql:string,args?:unknown[])=>({rows:(await tx.query<T>(sql,args)).rows})}))};
 const fresh=async()=>({customerId:customer});
 const task=await db.transaction(tx=>issueTask(tx,{jobId:job,requestId:turn},fresh,pin));
 const token=mintTaskToken(task,'test-only-signing-key-'.repeat(3),'https://example.test/api/mcp/internal/mcp');
 const body=copilotCreateBody({id:turn,task,taskToken:token,question,budgetMicroUsd:200000});
 const store=new CopilotDispatchStore(db,Buffer.alloc(32,7),fresh,()=>pin);
 await store.prepare({id:turn,task,threadId:'thread1',turnId:turn,requestDigest:createHash('sha256').update(question).digest('hex'),body,budget:{amountMicroUsd:200000,jobCapMicroUsd:1000000,agentMonth:'2026-11',agentMonthCapMicroUsd:20000000,customerDay:'2026-11-08',customerDayCapMicroUsd:2000000}});
 const snapshot:NaiveSessionSnapshot={id:session,agentId:pin.agentId,agentVersion:1,status:'completed',stopReason:null,stopCode:null,structuredOutput:null,budgetMicroUsd:200000,consumedMicroUsd:120000,tokenUsage:{input:10,output:20},metadata:{ae_copilot_dispatch:turn,ae_internal_task:task.id,ae_role:'copilot'}};
 const provider={createSession:vi.fn(async()=>snapshot),getSession:vi.fn(async()=>snapshot),listAgentSessions:vi.fn(async()=>({data:[snapshot]}))};
 const dispatch=()=>dispatchCopilot(turn,{store,provider,workerId:'worker',publicationInput:async(tx)=>({question,snapshot:await readInternalProgress(tx,{customerId:customer,jobId:job}),knownSecrets:[token]}),publish:async(tx,r,reply)=>createPostgresConversationPort({...tx,transaction:fn=>fn(tx)}).append({subjectId:customer,jobId:job},{messageId:r.turnId,inputDigest:r.requestDigest,reply})});
 return {pg,db,store,task,token,provider,dispatch};
}

it('composes signed task, encrypted intent, actual SQL runner/publication and exactly-once application accounting',async()=>{
 const f=await fixture();
 const result=await f.dispatch();expect(result.status).toBe('published');
 expect(f.provider.createSession).toHaveBeenCalledOnce();
 expect((await f.pg.query<{revoked_at:unknown}>('SELECT revoked_at FROM naive_internal.tasks')).rows[0]?.revoked_at).toBeTruthy();
 const history=await createPostgresConversationPort(f.db).list({subjectId:customer,jobId:job},{afterSequence:0,limit:20});
 expect(history).toHaveLength(1);expect(history[0]?.reply.text).toContain('running');
 expect(await deliverCopilotCost(f.db,turn)).toEqual({status:'delivered',inserted:true,microUsd:120000});
 expect(await deliverCopilotCost(f.db,turn)).toEqual({status:'delivered',inserted:false,microUsd:120000});
 const costs=(await f.pg.query<{agent:unknown;micro_usd:number;meta:Record<string,unknown>}>('SELECT * FROM costs')).rows;
 expect(costs).toHaveLength(1);expect(costs[0]?.agent).toBeNull();expect(costs[0]?.meta.measured).toBe(true);expect(costs[0]?.meta.role).toBe('copilot');
 expect((await f.pg.query<{settled_micro_usd:number}>('SELECT settled_micro_usd FROM agent_persistence.reservations')).rows[0]?.settled_micro_usd).toBe(120000);
 for(const table of ['naive_copilot.dispatches','naive_copilot.cost_outbox','reporting_chat_exchanges','costs','naive_internal.audit'])expect(JSON.stringify((await f.pg.query('SELECT * FROM '+table)).rows)).not.toContain(f.token);
});
it('rolls back cost insertion when acknowledgement fails, then safely retries the same receipt',async()=>{
 const f=await fixture();await f.dispatch();
 const failing={...f.db,transaction:<T>(fn:(tx:AgentSqlExecutor)=>Promise<T>)=>f.db.transaction(tx=>fn({query:async<T>(sql:string,args?:unknown[])=>{if(sql.startsWith('UPDATE naive_copilot.cost_outbox'))throw Error('private database diagnostic');return tx.query<T>(sql,args);}}))};
 await expect(deliverCopilotCost(failing,turn)).rejects.toThrow('copilot_accounting_unavailable');
 expect((await f.pg.query('SELECT * FROM costs')).rows).toHaveLength(0);
 expect((await f.pg.query<{delivered_at:unknown}>('SELECT delivered_at FROM naive_copilot.cost_outbox')).rows[0]?.delivered_at).toBeNull();
 expect((await deliverCopilotCost(f.db,turn)).status).toBe('delivered');
});
it('refuses an ownership change after provider usage without losing the accounting obligation',async()=>{
 const f=await fixture();await f.dispatch();
 const other='10000000-0000-4000-8000-000000000002';await f.pg.query('INSERT INTO customers VALUES($1)',[other]);await f.pg.query('UPDATE jobs SET customer_id=$1 WHERE id=$2',[other,job]);
 await expect(deliverCopilotCost(f.db,turn)).rejects.toThrow('copilot_accounting_unavailable');
 expect((await f.pg.query('SELECT * FROM costs')).rows).toHaveLength(0);
 expect((await f.pg.query<{delivered_at:unknown}>('SELECT delivered_at FROM naive_copilot.cost_outbox')).rows[0]?.delivered_at).toBeNull();
});
it('recovers an accepted create with a lost response without issuing another create or releasing unknown spend',async()=>{
 const f=await fixture();f.provider.createSession.mockRejectedValueOnce(Error('private response body'));
 expect(await f.dispatch()).toEqual({status:'held',code:'dispatch_unavailable'});
 expect((await f.store.get(turn))?.state).toBe('ambiguous');
 expect((await f.pg.query<{settled_micro_usd:unknown}>('SELECT settled_micro_usd FROM agent_persistence.reservations')).rows[0]?.settled_micro_usd).toBeNull();
 await f.pg.query('UPDATE naive_copilot.dispatches SET lease_until=0 WHERE id=$1',[turn]);
 expect((await f.dispatch()).status).toBe('published');
 expect(f.provider.createSession).toHaveBeenCalledOnce();expect(f.provider.listAgentSessions).toHaveBeenCalledOnce();expect(f.provider.getSession).toHaveBeenCalledWith(session);
 expect((await deliverCopilotCost(f.db,turn)).status).toBe('delivered');
});
it('revokes a terminal failed session capability while retaining its measured accounting receipt',async()=>{
 const f=await fixture();const snapshot=await f.provider.getSession();f.provider.createSession.mockResolvedValueOnce({...snapshot,status:'failed'});
 expect(await f.dispatch()).toEqual({status:'held',code:'terminal_failure'});
 expect((await f.pg.query<{revoked_at:unknown}>('SELECT revoked_at FROM naive_internal.tasks')).rows[0]?.revoked_at).toBeTruthy();
 expect((await deliverCopilotCost(f.db,turn)).status).toBe('delivered');
 expect((await f.pg.query('SELECT * FROM reporting_chat_exchanges')).rows).toHaveLength(0);
});
