import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterEach,expect,it,vi} from 'vitest';
import {PostgresRemediationAccounting} from '../../../packages/core/src/evals/remediation/accounting/index';
import {PostgresAccountingReconciliationWorker} from '../../../packages/core/src/evals/remediation/accounting/reconciliation/index';
import type {AgentTransactionalSql} from '../../../packages/core/src/agents/postgres-ports';
import type {DispatchEvidence} from '../../../packages/core/src/targets/remediation';
const digest='a'.repeat(64), usage={promptTokens:2,completionTokens:3,totalTokens:5};
const engines:PGlite[]=[];
afterEach(async()=>{for(const e of engines.splice(0))await e.close();});
async function fixture(){
 const engine=new PGlite();engines.push(engine);let tail:Promise<unknown>=Promise.resolve();
 const serial=<T>(fn:()=>Promise<T>)=>{const result=tail.then(fn);tail=result.catch(()=>{});return result;};
 const sql:AgentTransactionalSql={query:(s,p)=>serial(()=>engine.query(s,p)),transaction:fn=>serial(()=>engine.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)})))};
 for(const path of ['agents/persistence-migrations/001-agent-persistence.sql','evals/remediation/accounting/001-remediation-accounting.sql','evals/remediation/accounting/reconciliation/001-reconciliation.sql'])await engine.exec(readFileSync(new URL('../../../packages/core/src/'+path,import.meta.url),'utf8'));
 await engine.exec('CREATE TABLE current_authority(job_id text PRIMARY KEY,enabled boolean NOT NULL); INSERT INTO current_authority VALUES (\'job\',true);CREATE SCHEMA workflow_integration;CREATE TABLE workflow_integration.cost_keys(key text PRIMARY KEY,job_id text,payload jsonb)');
 const scopeKeys=['job:job','agent:evaluation_engineer:period','autonomous-root:tenant:period'];
 const reservation=(op:{operationId:string})=>({jobId:'job',reservationId:op.operationId,amountMicroUsd:40,scopes:scopeKeys.map(key=>({key,capMicroUsd:200}))});
 let failSink=false;
 const deliverCost=vi.fn(async(tx:any,cost:any)=>{await tx.query('INSERT INTO workflow_integration.cost_keys VALUES($1,$2,$3::jsonb)',[cost.idempotencyKey,cost.jobId,JSON.stringify(cost)]);if(failSink)throw Error('sink failure');});
 const authority={jobId:'job',scopeKeys,guard:vi.fn(async(tx:any)=>{const row=(await tx.query('SELECT enabled FROM current_authority WHERE job_id=$1 FOR UPDATE',['job'])).rows[0];if(!row?.enabled)throw Error('revoked');})};
 const accounting=new PostgresRemediationAccounting({sql,jobId:'job',reservation,deliverCost});
 const receipt=(id='op')=>({operationId:id,inputDigest:digest,provider:'offline-fixture',accountId:'account',externalRequestId:'request-'+id,externalReceiptId:'receipt-'+id,usage,microUsd:12,currency:'USD' as const,evidenceDigest:'b'.repeat(64)});
 const adapter={provider:'offline-fixture',accountId:'account',capability:'authoritative-priced-receipts' as const,retrieve:vi.fn(async(binding:any)=>receipt(binding.operationId)),authenticate:vi.fn(async()=>true)};
 const make=(port=sql)=>new PostgresAccountingReconciliationWorker({sql:port,authority,adapters:[adapter],reservation,deliverCost});
 const add=async(id='op',bind=true)=>{await accounting.authorize({operationId:id,inputDigest:digest,kind:'target'});const evidence:DispatchEvidence={operationId:id,inputDigest:digest,jobId:'job',targetId:'target',targetVersion:'v1',environment:'test',trialId:'trial',baselineRunId:'baseline',suiteDigest:digest,runId:'run',scenarioId:'scenario',patchDigest:digest,payloadDigest:digest};await accounting.beforeDispatch(evidence);await accounting.observed(evidence,usage);await accounting.ambiguous(evidence);if(bind)await make().registerProviderBinding({operationId:id,inputDigest:digest,provider:adapter.provider,accountId:adapter.accountId,externalRequestId:'request-'+id});};
 const costs=async()=>(await sql.query('SELECT * FROM workflow_integration.cost_keys')).rows;
 const pending=()=>accounting.pending();
 return {engine,sql,authority,adapter,make,add,receipt,costs,pending,failSink:(v:boolean)=>{failSink=v;},reservation};
}
it('reconstructed worker settles once; overlapping local SQL ticks never duplicate the keyed cost',async()=>{
 const f=await fixture();await f.add();await Promise.all([f.make().run({limit:10}),f.make().run({limit:10})]);expect(await f.costs()).toHaveLength(1);expect(await f.pending()).toHaveLength(0);await f.make().run({limit:10});expect(await f.costs()).toHaveLength(1);
});
it('absent binding, unavailable receipt, and unknown money retain all holds',async()=>{
 const f=await fixture();await f.add('unbound',false);await f.add('unknown');f.adapter.retrieve.mockResolvedValue(null as any);await f.make().run({limit:10});expect(await f.costs()).toHaveLength(0);expect(await f.pending()).toHaveLength(2);expect((await f.sql.query('SELECT * FROM agent_persistence.reservations WHERE settled_micro_usd IS NULL')).rows).toHaveLength(2);
});
it('current authority is checked before retrieval and again after retrieval revocation',async()=>{
 const f=await fixture();await f.add();await f.sql.query('UPDATE current_authority SET enabled=false');await f.make().run({limit:10}).catch(()=>{});expect(f.adapter.retrieve).not.toHaveBeenCalled();await f.sql.query('UPDATE current_authority SET enabled=true');f.adapter.retrieve.mockImplementation(async()=>{await f.sql.query('UPDATE current_authority SET enabled=false');return f.receipt();});await f.make().run({limit:10}).catch(()=>{});expect(await f.costs()).toHaveLength(0);expect(await f.pending()).toHaveLength(1);
});
it.each(['operationId','inputDigest','provider','accountId','externalRequestId','usage','microUsd','currency'] as const)('rejects conflicting receipt %s',async(field)=>{
 const f=await fixture();await f.add();const changed={...f.receipt(),[field]:field==='usage'?{...usage,totalTokens:6}:field==='microUsd'?-1:'different'};f.adapter.retrieve.mockResolvedValue(changed as any);await f.make().run({limit:10});expect(await f.costs()).toHaveLength(0);expect(await f.pending()).toHaveLength(1);
});
it('unauthenticated evidence cannot settle',async()=>{const f=await fixture();await f.add();f.adapter.authenticate.mockResolvedValue(false);await f.make().run({limit:10});expect(await f.costs()).toHaveLength(0);expect(await f.pending()).toHaveLength(1);});
it('sink failure rolls back settlement; restart uses retained exact receipt despite provider change',async()=>{
 const f=await fixture();await f.add();f.failSink(true);await f.make().run({limit:10});expect(await f.costs()).toHaveLength(0);expect(await f.pending()).toHaveLength(1);f.failSink(false);f.adapter.retrieve.mockResolvedValue({...f.receipt(),microUsd:99});await f.make().run({limit:10});expect(await f.costs()).toHaveLength(1);const row=(await f.sql.query<{settlement:{microUsd:number}}>('SELECT settlement FROM remediation_accounting.operations')).rows[0];expect(row.settlement.microUsd).toBe(12);
});
it('a replayed external receipt cannot settle a different operation',async()=>{
 const f=await fixture();await f.add('one');await f.add('two');f.adapter.retrieve.mockImplementation(async(binding:any)=>({...f.receipt(binding.operationId),externalReceiptId:'same-external-receipt'}));await f.make().run({limit:10});expect(await f.costs()).toHaveLength(1);expect(await f.pending()).toHaveLength(1);
});
it('scans bounded pages without releasing unknown earlier holds',async()=>{
 const f=await fixture();await f.add('a');await f.add('b');await f.add('c');const result=await f.make().run({limit:1});expect(result.scanned).toBe(1);expect(await f.costs()).toHaveLength(1);expect(await f.pending()).toHaveLength(2);await expect(f.make().run({limit:1000000})).rejects.toThrow();
});

it('lost commit acknowledgement survives restart without another lookup or cost',async()=>{
 const f=await fixture();await f.add();let dropped=false;
 const ambiguous:AgentTransactionalSql={query:f.sql.query,transaction:async fn=>{let settlement=false;const value=await f.sql.transaction(tx=>fn({query:async <T>(s:string,p?:unknown[])=>{if(s.startsWith('UPDATE remediation_accounting.operations SET settlement'))settlement=true;return tx.query<T>(s,p);}}));if(settlement&&!dropped){dropped=true;throw Error('commit acknowledgement lost');}return value;}};
 const first=await f.make(ambiguous).run({limit:10});expect(first.failed).toBe(1);expect(dropped).toBe(true);expect(await f.costs()).toHaveLength(1);await f.make().run({limit:10});expect(await f.costs()).toHaveLength(1);expect(f.adapter.retrieve).toHaveBeenCalledOnce();
});
it('policy cap drift refuses lookup, and scope mismatch filters pending operations',async()=>{
 const f=await fixture();await f.add();await f.sql.query(`UPDATE remediation_accounting.operations SET reservation=jsonb_set(reservation,'{amountMicroUsd}','41'::jsonb)`);await f.make().run({limit:10});expect(f.adapter.retrieve).not.toHaveBeenCalled();expect(await f.costs()).toHaveLength(0);
 await f.sql.query(`UPDATE remediation_accounting.operations SET reservation=jsonb_set(reservation,'{scopes}','[]'::jsonb)`);const result=await f.make().run({limit:10});expect(result.scanned).toBe(0);expect(await f.pending()).toHaveLength(1);
});
it('authoritative zero settles, null money and unavailable capability do not',async()=>{
 const f=await fixture();await f.add('zero');await f.add('unknown');f.adapter.retrieve.mockImplementation(async b=>({...f.receipt(b.operationId),microUsd:b.operationId==='zero'?0:null}) as any);await f.make().run({limit:10});expect(await f.costs()).toHaveLength(1);expect(await f.pending()).toHaveLength(1);expect((await f.sql.query<{settlement:{microUsd:number}}>("SELECT settlement FROM remediation_accounting.operations WHERE operation_id='zero'")).rows[0].settlement.microUsd).toBe(0);
});
it('provider binding is immutable across reconstruction',async()=>{
 const f=await fixture();await f.add();await expect(f.make().registerProviderBinding({operationId:'op',inputDigest:digest,provider:'offline-fixture',accountId:'account',externalRequestId:'changed'})).rejects.toThrow();expect(await f.costs()).toHaveLength(0);
});
it('unavailable provider capability and lookup timeout keep the durable hold',async()=>{
 const f=await fixture();await f.add();Object.assign(f.adapter,{capability:'unavailable'});await f.make().run({limit:10});expect(f.adapter.retrieve).not.toHaveBeenCalled();Object.assign(f.adapter,{capability:'authoritative-priced-receipts'});f.adapter.retrieve.mockImplementation(()=>new Promise(()=>{}));const result=await f.make().run({limit:1,lookupTimeoutMs:5,maxDurationMs:20});expect(result.failed).toBe(1);expect(await f.costs()).toHaveLength(0);expect(await f.pending()).toHaveLength(1);
});
