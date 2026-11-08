import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {createAutonomyReleaseServer,type ReleaseConfig} from '@/server/autonomy-release';
import {assertAutonomousPaidContext} from '@/server/autonomous-paid';
import {autonomyDigest,type AutonomousPolicy} from '../../../packages/core/src/agents/autonomy/policy';
import type {CompanyPorts,CompanyRequest} from '../../../packages/core/src/agents/autonomy/company';
import {memoryDataLedger} from '../autonomous-company/data-fixtures';
const dispatch=vi.hoisted(()=>({run:vi.fn()}));
vi.mock('@ae/core/agents/autonomy/company',async original=>({...await original<typeof import('../../../packages/core/src/agents/autonomy/company')>(),advanceAutonomousCompany:(request:CompanyRequest,ports:CompanyPorts)=>dispatch.run(request,ports)}));
const engines:PGlite[]=[];
afterEach(async()=>{dispatch.run.mockReset();await Promise.all(engines.splice(0).map(db=>db.close()));});
async function setup(){
 const engine=new PGlite();engines.push(engine);
 await engine.exec(readFileSync(new URL('../../../docs/autonomy-release-adoption/source/apps/web/src/server/autonomy-release.sql',import.meta.url),'utf8'));
 await engine.exec(readFileSync(join(process.env.WORKFLOW_STAGE!,'apps/web/src/server/autonomous-paid-authority.sql'),'utf8'));
 const request:CompanyRequest={tenantId:'tenant_a',round:0,job:{jobId:'job_a',customerId:'tenant_a',package:'text_eval',environment:'test',isFixture:true,quoteVersion:1,linkedRetestOf:null},intake:{requestedPackage:'text_eval',notes:'Untrusted intake',systemPromptExcerpt:null,trace:null,endpointHost:'fixture.invalid',clarifications:[]}};
 const policy={schema:'autonomous-company-policy/v1',version:'v1',enabled:true,tenantId:'tenant_a',periodId:'period',rootBudgetMicroUsd:250000000,singleJobCapMicroUsd:3000000,comparisonJobCapMicroUsd:5000000,roleCapsMicroUsd:{commercial:35000000,evaluation_engineer:65000000,quality_investigator:65000000,company_operator:35000000},agents:{commercial:{id:'commercial',version:1},evaluation_engineer:{id:'engineer',version:1},quality_investigator:{id:'investigator',version:1},company_operator:{id:'operator',version:1}},allowedActions:['agent_task'],leaseMs:100,actionDeadlineMs:60000,maxRecoveryChecks:3} satisfies AutonomousPolicy;
 const operations=memoryDataLedger();let authorized=true,clock=100;
 const config:ReleaseConfig={db:{query:(sql,p)=>engine.query(sql,p),transaction:fn=>engine.transaction(tx=>fn({query:(sql,p)=>tx.query(sql,p)}))},
  authenticateScheduler:async token=>token==='scheduler',authenticateCustomer:async token=>token==='customer'?{tenantId:'tenant_a',subject:'owner_a'}:token==='other'?{tenantId:'tenant_b',subject:'owner_b'}:null,
  loadRequest:async(p,id)=>p.tenantId==='tenant_a'&&id==='job_a'?structuredClone(request):null,authorizeJob:async()=>authorized,
  policyFor:async tenant=>tenant===policy.tenantId?structuredClone(policy):null,currentSecrets:async()=>[],
  naive:{createSession:vi.fn(async()=>{throw new Error('no_provider');}),getSession:vi.fn(async()=>{throw new Error('no_provider');}),listAgentSessions:vi.fn(async()=>({data:[],nextCursor:null}))},
  workerId:'worker',idempotencyNamespace:'offline',operationsFor:async()=>operations,
  sourcePermissions:async()=>[{sourceId:'source_a',permissionDigest:'a'.repeat(64)}],verifyPayment:vi.fn(async()=>true),verifyProviderReceipt:vi.fn(async()=>true),
  paidPolicy:vi.fn(async()=>({jobCapMicroUsd:3000000,targetReservationMicroUsd:20,judgeReservationMicroUsd:20})),
  data:vi.fn(async()=>({status:'ready' as const,digest:'b'.repeat(64),reasons:[]})),evaluate:vi.fn(async()=>{throw new Error('unused');}),recoverEvaluation:vi.fn(async()=>null),enqueue:vi.fn(async()=>{}),now:()=>clock};
 const app=createAutonomyReleaseServer(config);
 const permission=()=>engine.query("INSERT INTO company_autonomy_release.source_permissions(tenant_id,job_id,source_id,permission_digest,allowed,expires_at) VALUES('tenant_a','job_a','source_a',$1,true,1000)",['a'.repeat(64)]);
 return {engine,request,policy,operations,config,app,permission,revoke:()=>{authorized=false;},advance:()=>{clock=1001;}};
}
async function tick(h:Awaited<ReturnType<typeof setup>>){const result=await h.app.scheduledTick('scheduler');expect(result.outcomes[0]).toMatchObject({reason:'test'});return result;}
const done={state:'payment_wait',reason:'test',policyVersion:'v1',founderInterventions:0,costStatus:'known'};
describe('authenticated autonomous owner composition (offline PostgreSQL)',()=>{
 it('rejects unauthenticated scheduler before enumerating or dispatching jobs',async()=>{const h=await setup();await expect(h.app.scheduledTick(undefined)).rejects.toThrow('authority_refused');expect(dispatch.run).not.toHaveBeenCalled();});
 it('bootstrap authenticates and resolves canonical job instead of accepting request authority',async()=>{const h=await setup();await expect(h.app.bootstrap(undefined,'job_a')).rejects.toThrow();await expect(h.app.bootstrap('other','job_a')).rejects.toThrow();expect(await h.app.bootstrap('customer','job_a')).toMatchObject({authority:'automated_review',policyVersion:'v1'});await h.app.bootstrap('customer','job_a');expect((await h.engine.query('SELECT * FROM company_autonomy_release.job_bindings')).rows).toHaveLength(1);});
 it('refuses a changed request and policy under an existing durable binding',async()=>{const h=await setup();await h.app.bootstrap('customer','job_a');h.request.intake.notes='changed';await expect(h.app.bootstrap('customer','job_a')).rejects.toThrow();h.policy.version='v2';expect((await h.app.scheduledTick('scheduler')).outcomes[0]).toMatchObject({state:'exception'});expect(dispatch.run).not.toHaveBeenCalled();});
 it('scheduler scans bounded SQL and rechecks current tenant authorization',async()=>{const h=await setup();await h.app.bootstrap('customer','job_a');h.revoke();expect((await h.app.scheduledTick('scheduler')).outcomes[0]).toMatchObject({state:'exception'});expect(dispatch.run).not.toHaveBeenCalled();});
 it('source permission absence and expiry remain unassessed and block target execution',async()=>{const h=await setup();await h.app.bootstrap('customer','job_a');dispatch.run.mockImplementation(async(_r,p:CompanyPorts)=>{expect(await p.data('data')).toMatchObject({status:'not_assessed'});await expect(p.evaluate('eval','b'.repeat(64))).rejects.toThrow();return done;});await tick(h);await h.permission();h.advance();await h.engine.query('UPDATE company_autonomy_release.job_bindings SET next_tick_at=0');await tick(h);expect(h.config.data).not.toHaveBeenCalled();expect(h.config.evaluate).not.toHaveBeenCalled();});
 it('authorized exact source digest reaches data admission but revocation before evaluation refuses',async()=>{const h=await setup();await h.app.bootstrap('customer','job_a');await h.permission();dispatch.run.mockImplementation(async(_r,p:CompanyPorts)=>{expect(await p.data('data')).toMatchObject({status:'ready'});await h.engine.query("UPDATE company_autonomy_release.source_permissions SET allowed=false");await expect(p.evaluate('eval','b'.repeat(64))).rejects.toThrow();return done;});await tick(h);expect(h.config.data).toHaveBeenCalledOnce();expect(h.config.evaluate).not.toHaveBeenCalled();});
 it('payment requires exact quote, settled amount and authoritative verification; missing stays waiting',async()=>{const h=await setup();await h.app.bootstrap('customer','job_a');const quote={jobId:'job_a',version:1,package:'text_eval' as const,priceMicroUsd:5000000,priceCents:500,priceLabel:'$5',scopeSummary:'scope',deliverables:[],environment:'test' as const,countsAsRevenue:false};dispatch.run.mockImplementation(async(_r,p:CompanyPorts)=>{expect(await p.payment(quote)).toBe('waiting');await h.engine.query("INSERT INTO company_autonomy_release.payment_receipts(tenant_id,job_id,receipt_id,settled,record) VALUES('tenant_a','job_a','pending',false,$1::jsonb)",[JSON.stringify({quoteDigest:autonomyDigest(quote)})]);expect(await p.payment(quote)).toBe('waiting');await h.engine.query("INSERT INTO company_autonomy_release.payment_receipts(tenant_id,job_id,receipt_id,settled,amount_micro_usd,record) VALUES('tenant_a','job_a','receipt',true,5000000,$1::jsonb)",[JSON.stringify({quoteDigest:autonomyDigest(quote)})]);expect(await p.payment(quote)).toBe('paid');vi.mocked(h.config.verifyPayment).mockResolvedValue(false);expect(await p.payment(quote)).toBe('invalid');return done;});await tick(h);expect(h.config.verifyPayment).toHaveBeenCalledTimes(2);});
 it('receipt absence never fabricates provider success or redispatches evaluation',async()=>{const h=await setup();await h.app.bootstrap('customer','job_a');await h.permission();dispatch.run.mockImplementation(async(_r,p:CompanyPorts)=>{expect(await p.recoverEvaluation('eval')).toBeNull();return done;});await tick(h);expect(h.config.recoverEvaluation).not.toHaveBeenCalled();expect(h.config.evaluate).not.toHaveBeenCalled();});
 it('unverified provider receipt never reaches retained evaluation recovery',async()=>{const h=await setup();await h.app.bootstrap('customer','job_a');await h.permission();await h.engine.query("INSERT INTO company_autonomy_release.provider_receipts(tenant_id,job_id,action_key,provider_id,receipt) VALUES('tenant_a','job_a','eval','provider',$1::jsonb)",[JSON.stringify({opaque:'receipt'})]);vi.mocked(h.config.verifyProviderReceipt).mockResolvedValue(false);dispatch.run.mockImplementation(async(_r,p:CompanyPorts)=>{expect(await p.recoverEvaluation('eval')).toBeNull();return done;});await tick(h);expect(h.config.recoverEvaluation).not.toHaveBeenCalled();});
 it('reauthorizes durable publication reads and keeps automated authority distinct from legacy human',async()=>{const h=await setup();await h.app.bootstrap('customer','job_a');const key='autonomous-company:tenant_a:job_a:0:published-report',record={tenantId:'tenant_a',jobId:'job_a',artifactId:'report_a',rendered:{markdown:'report'}};await h.operations.claim(key,autonomyDigest(record));await h.operations.complete(key,autonomyDigest(record),record);expect(await h.app.publication('customer','job_a')).toMatchObject({authority:'automated_review',publication:record});await expect(h.app.publication('other','job_a')).rejects.toThrow();h.revoke();await expect(h.app.publication('customer','job_a')).rejects.toThrow();});
 it('guards effects after authorization changes during a tick',async()=>{const h=await setup();await h.app.bootstrap('customer','job_a');dispatch.run.mockImplementation(async(_r,p:CompanyPorts)=>{h.revoke();await expect(p.enqueue('message',{kind:'monitoring_offer'})).rejects.toThrow();await expect(p.operations.get('any')).rejects.toThrow();return done;});await tick(h);expect(h.config.enqueue).not.toHaveBeenCalled();});
});

it('release evaluation receives an issued context pinned to canonical company/job and the same guarded runner',async()=>{
 const h=await setup();await h.app.bootstrap('customer','job_a');await h.permission();
 vi.mocked(h.config.evaluate).mockImplementation(async(request,key,digest,runner,paid)=>{
  expect(request).toEqual(h.request);expect(key).toBe('evaluation');expect(digest).toBe('b'.repeat(64));
  expect(runner).toBe(paid.runner);expect(paid.job).toEqual(h.request.job);expect(paid.policy).toEqual(h.policy);expect(paid.sql).toBe(h.config.db);
  expect(()=>assertAutonomousPaidContext(paid)).not.toThrow();
  await paid.guard();h.revoke();await expect(paid.guard()).rejects.toThrow();
  throw Error('fixture completes after verifying revocation');
 });
 dispatch.run.mockImplementation(async(_r,p:CompanyPorts)=>{await expect(p.evaluate('evaluation','b'.repeat(64))).rejects.toThrow();return done;});
 await tick(h);expect(h.config.evaluate).toHaveBeenCalledOnce();
});
it('changing the server paid policy during a tick refuses evaluation before any adapter dispatch',async()=>{
 const h=await setup();await h.app.bootstrap('customer','job_a');await h.permission();
 dispatch.run.mockImplementation(async(_r,p:CompanyPorts)=>{
  vi.mocked(h.config.paidPolicy).mockResolvedValue({jobCapMicroUsd:3000000,targetReservationMicroUsd:21,judgeReservationMicroUsd:20});
  await expect(p.evaluate('eval','b'.repeat(64))).rejects.toThrow();return done;
 });
 await tick(h);expect(h.config.evaluate).not.toHaveBeenCalled();
});
it('a deserialized context and a cloned issued context carry no server authority',()=>{
 expect(()=>assertAutonomousPaidContext({} as Parameters<typeof assertAutonomousPaidContext>[0])).toThrow();
});
it.each(['company-policy','paid-policy'] as const)('durable bootstrap pins %s across a fresh server instance even when version stays the same',async change=>{
 const h=await setup();await h.app.bootstrap('customer','job_a');await h.permission();
 if(change==='company-policy')h.policy.rootBudgetMicroUsd+=1;
 else vi.mocked(h.config.paidPolicy).mockResolvedValue({jobCapMicroUsd:3000000,targetReservationMicroUsd:21,judgeReservationMicroUsd:20});
 const restarted=createAutonomyReleaseServer(h.config);
 await expect(restarted.bootstrap('customer','job_a')).rejects.toThrow();
 expect((await restarted.scheduledTick('scheduler')).outcomes[0]).toMatchObject({state:'exception'});
 expect(dispatch.run).not.toHaveBeenCalled();expect(h.config.evaluate).not.toHaveBeenCalled();
},30000);

it('preexisting release bindings without reviewed authority digest remain refused and never backfill on bootstrap',async()=>{
 const h=await setup();await h.app.bootstrap('customer','job_a');
 await h.engine.query('UPDATE company_autonomy_release.job_bindings SET authority_digest=NULL');
 const restarted=createAutonomyReleaseServer(h.config);
 await expect(restarted.bootstrap('customer','job_a')).rejects.toThrow();
 expect((await restarted.scheduledTick('scheduler')).outcomes[0]).toMatchObject({state:'exception'});
 expect((await h.engine.query<{authority_digest:string|null}>('SELECT authority_digest FROM company_autonomy_release.job_bindings')).rows[0].authority_digest).toBeNull();
 expect(dispatch.run).not.toHaveBeenCalled();
},30000);
