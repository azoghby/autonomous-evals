import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {it,expect,afterEach,vi} from 'vitest';
import {GET} from '@report-route';
import {createCurrentAutonomyApplication} from '@/server/current-autonomy';
import {autonomyDigest} from '@ae/core/agents/autonomy/policy';
import {runtimeFixture} from './publication-runtime';
const engines:PGlite[]=[];afterEach(async()=>{runtimeFixture.app=undefined;await Promise.all(engines.splice(0).map(db=>db.close()));});
async function setup(){
 const engine=new PGlite();engines.push(engine);
 await engine.exec(readFileSync(join(process.env.PUBLICATION_STAGE!,'apps/web/src/server/autonomy-release.sql'),'utf8'));
 await engine.exec(readFileSync(join(process.env.PUBLICATION_STAGE!,'apps/web/src/server/autonomous-paid-authority.sql'),'utf8'));
 const request={tenantId:'tenant_a',round:0,job:{jobId:'job_a',customerId:'tenant_a',package:'text_eval',environment:'test',isFixture:true,quoteVersion:1,linkedRetestOf:null},intake:{requestedPackage:'text_eval',notes:'fixture',systemPromptExcerpt:null,trace:null,endpointHost:'fixture.invalid',clarifications:[]}};
 const policy={schema:'autonomous-company-policy/v1',version:'v1',enabled:true,tenantId:'tenant_a',periodId:'period',rootBudgetMicroUsd:250000000,singleJobCapMicroUsd:3000000,comparisonJobCapMicroUsd:5000000,roleCapsMicroUsd:{commercial:35000000,evaluation_engineer:65000000,quality_investigator:65000000,company_operator:35000000},agents:{commercial:{id:'commercial',version:1},evaluation_engineer:{id:'engineer',version:1},quality_investigator:{id:'investigator',version:1},company_operator:{id:'operator',version:1}},allowedActions:['agent_task'],leaseMs:100,actionDeadlineMs:60000,maxRecoveryChecks:3};
 const paidPolicy={jobCapMicroUsd:3000000,targetReservationMicroUsd:20,judgeReservationMicroUsd:20};
 const publication={tenantId:'tenant_a',jobId:'job_a',artifactId:'private-artifact',rendered:{markdown:'PRIVATE_REPORT_SENTINEL'}};
 await engine.query('INSERT INTO company_autonomy_release.job_bindings(tenant_id,job_id,owner_id,policy_version,request,enabled,next_tick_at,authority_digest) VALUES($1,$2,$3,$4,$5::jsonb,true,$6,$7)',['tenant_a','job_a','tenant_a','v1',JSON.stringify(request),100,autonomyDigest({policy,paidPolicy})]);
 let viewer:any={id:'tenant_a',email:'synthetic@example.invalid',isOperator:false};
 let owner='tenant_a';
 let release!:()=>void,entered!:()=>void;
 const pending=new Promise<void>(r=>{release=r}),reading=new Promise<void>(r=>{entered=r});
 const operations={get:vi.fn(async()=>{entered();await pending;return {state:'complete',result:publication};}),claim:vi.fn(),complete:vi.fn()};
 const never=vi.fn(async()=>{throw Error('provider_fixture_must_not_be_called');});
 const config:any={db:{query:(sql:string,p:any)=>engine.query(sql,p),transaction:(fn:any)=>engine.transaction(tx=>fn({query:(sql:string,p:any)=>tx.query(sql,p)}))},loadRequest:async()=>structuredClone(request),policyFor:async()=>structuredClone(policy),currentSecrets:async()=>[],naive:{createSession:never,getSession:never,listAgentSessions:never},workerId:'offline',idempotencyNamespace:'offline',operationsFor:async()=>operations,sourcePermissions:async()=>[],verifyPayment:never,verifyProviderReceipt:never,paidPolicy:async()=>paidPolicy,data:never,evaluateWithServices:never,recoverEvaluation:never,enqueue:never,now:()=>100,contextFor:never};
 const app=createCurrentAutonomyApplication(config,{viewer:async()=>viewer,cron:()=>null,job:async()=>({id:'job_a',customerId:owner,workflowRunId:'workflow',environment:'test',isMock:false})});
 runtimeFixture.app=app;
 const get=()=>GET(new Request('https://app.example/api/jobs/job_a/autonomy/report'),{params:Promise.resolve({jobId:'job_a'})});
 return {get,reading,release,operations,never,revoke:()=>{viewer=null;},transfer:()=>{owner='other';}};
}
it('returns the scoped report for a currently authorized owner through actual route/current app/release/SQL binding',async()=>{
 const h=await setup();const responsePromise=h.get();await h.reading;h.release();const response=await responsePromise;
 expect(response.status).toBe(200);expect((await response.json()).publication.rendered.markdown).toBe('PRIVATE_REPORT_SENTINEL');expect(h.operations.get).toHaveBeenCalledOnce();expect(h.never).not.toHaveBeenCalled();
});
it('denies report disclosure when the scripted cookie session is revoked while publication lookup is pending',async()=>{
 const h=await setup();const responsePromise=h.get();await h.reading;h.revoke();h.release();const response=await responsePromise;
 const body=await response.text();expect({status:response.status,privateReportDisclosed:body.includes('PRIVATE_REPORT_SENTINEL')}).toEqual({status:401,privateReportDisclosed:false});expect(h.never).not.toHaveBeenCalled();
});
it('denies report disclosure after canonical ownership changes during pending publication lookup',async()=>{
 const h=await setup();const responsePromise=h.get();await h.reading;h.transfer();h.release();const response=await responsePromise;
 expect(response.status).not.toBe(200);expect(await response.text()).not.toContain('PRIVATE_REPORT_SENTINEL');expect(h.never).not.toHaveBeenCalled();
});
