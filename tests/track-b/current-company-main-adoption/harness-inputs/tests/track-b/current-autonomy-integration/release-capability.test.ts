import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {it,expect,vi,afterEach} from 'vitest';
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
it('current release delivers one minted authority to data, evaluation and consented outbox and guards revocation',async()=>{
 const h=await setup();await h.app.bootstrap('customer','job_a');await h.permission();
 let capability:Parameters<ReleaseConfig['evaluate']>[4]|undefined;
 vi.mocked(h.config.data).mockImplementation(async(_request,_key,paid)=>{assertAutonomousPaidContext(paid);await paid.guard();capability=paid;return {status:'ready',digest:'b'.repeat(64),reasons:[]};});
 vi.mocked(h.config.evaluate).mockImplementation(async(_request,_key,_digest,runner,paid)=>{expect(paid).toBe(capability);expect(runner).toBe(paid.runner);expect(paid.sql).toBe(h.config.db);return {status:'pending'} as never;});
 vi.mocked(h.config.enqueue).mockImplementation(async(_request,_key,_message,paid)=>{expect(paid).toBe(capability);await paid.guard();});
 dispatch.run.mockImplementation(async(_r,p:CompanyPorts)=>{
  expect(await p.data('data')).toMatchObject({status:'ready'});
  await p.evaluate('eval','b'.repeat(64));await p.enqueue('outbox',{kind:'monitoring_offer'});
  h.revoke();await expect(p.enqueue('revoked',{kind:'monitoring_offer'})).rejects.toThrow();
  return {state:'payment_wait',reason:'fixture',policyVersion:'v1',founderInterventions:0,costStatus:'known'};
 });
 const result=await h.app.scheduledTick('scheduler');expect(result.outcomes[0]).toMatchObject({reason:'fixture'});
 expect(h.config.data).toHaveBeenCalledOnce();expect(h.config.evaluate).toHaveBeenCalledOnce();expect(h.config.enqueue).toHaveBeenCalledOnce();
});
