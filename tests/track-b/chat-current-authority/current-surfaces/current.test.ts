import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({token:'owner-token', revoked:false, reads:0, owner:'owner', onRead:null as null|(()=>void), allowlist:'', rows:[] as unknown[]}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>f.token?{value:f.token}:undefined})}));
vi.mock('@ae/core/auth/magic-link',()=>({customerForSessionToken:async(t:string)=>!f.revoked&&t==='owner-token'?{id:'owner',email:'owner@example.test'}:t==='other-token'?{id:'other',email:'other@example.test'}:null}));
vi.mock('@ae/core/auth/tokens',()=>({isOperator:(email:string)=>f.allowlist===email}));
vi.mock('@/server/job-store',()=>({getJob:async(id:string)=>id===JOB?{id,customerId:f.owner,reportBlobPath:'private/report.md',intake:{},package:'trace_audit',error:null}:null}));
vi.mock('@ae/core/db/client',()=>({schema:{quotes:{},messages:{},progressEvents:{},findings:{},payments:{},remediations:{}},db:()=>({select:()=>({from:()=>({where:()=>({orderBy:async()=>[]})})})})}));
vi.mock('@/server/intake',()=>({summarizeIntake:()=>({label:'fixture'})}));
vi.mock('drizzle-orm',()=>({and:()=>{},asc:()=>{},desc:()=>{},eq:()=>{},sql:()=>{}}));
vi.mock('@ae/core/storage/blob',()=>({readJobArtifactText:async()=>{f.reads++;f.onRead?.();return 'OWNER_REPORT_CANARY'},readJobArtifact:async()=>{f.reads++;f.onRead?.();return {stream:'OWNER_REPORT_CANARY',size:19,contentType:'text/plain'}}}));
vi.mock('@/server/realtime',()=>({realtimeConfigured:()=>true,realtimeUrl:()=> 'https://realtime.invalid',sealJobLive:async()=>({token:'fixture-seal'})}));
import {getCurrentCustomer} from '@/server/session';
import {GET as artifact} from '@/app/api/jobs/[jobId]/artifacts/[kind]/route';
import {GET as job} from '@/app/api/jobs/[jobId]/route';
import {GET as live} from '@/app/api/jobs/[jobId]/live/route';
const JOB='11111111-1111-4111-8111-111111111111';
const ctx=(kind='report',jobId=JOB)=>({params:Promise.resolve({jobId,kind})});
const req=new Request('https://fixture.invalid/api/jobs/'+JOB);
beforeEach(()=>{Object.assign(f,{token:'owner-token',revoked:false,reads:0,owner:'owner',onRead:null,allowlist:''})});
for(const [name,route] of [['job',job],['live',live],['artifact',artifact]] as const){
 it(`${name}: anonymous denied`,async()=>{f.token='';expect((await route(req,ctx())).status).toBe(401);expect(f.reads).toBe(0)});
 it(`${name}: foreign denied without artifact read`,async()=>{f.token='other-token';expect((await route(req,ctx())).status).toBe(404);expect(f.reads).toBe(0)});
 it(`${name}: foreign and missing indistinguishable`,async()=>{f.token='other-token';const a=await route(req,ctx()),b=await route(req,ctx('report','22222222-2222-4222-8222-222222222222'));expect(a.status).toBe(b.status);expect(await a.text()).toBe(await b.text())});
 it(`${name}: revoked session denied on next request`,async()=>{expect((await route(req,ctx())).status).toBe(200);f.revoked=true;expect((await route(req,ctx())).status).toBe(401)});
}
for(const kind of ['report','suite','evidence','report-html']) it(`${kind}: private owner download and foreign denial`,async()=>{const a=await artifact(req,ctx(kind));expect(a.status).toBe(kind==='suite'?404:200);if(a.ok){expect(a.headers.get('cache-control')).toBe('private, no-store');expect(await a.text()).toContain('OWNER_REPORT_CANARY')}f.token='other-token';expect((await artifact(req,ctx(kind))).status).toBe(404)});
it('operator rights evaluated anew for every session lookup',async()=>{expect((await getCurrentCustomer())?.isOperator).toBe(false);f.allowlist='owner@example.test';expect((await getCurrentCustomer())?.isOperator).toBe(true);f.allowlist='';expect((await getCurrentCustomer())?.isOperator).toBe(false)});
it('ownership changed before request denies all routes',async()=>{f.owner='other';for(const route of [job,live,artifact])expect((await route(req,ctx())).status).toBe(404)});
it('RELEASE GATE: revocation while report load is pending must deny artifact',async()=>{f.onRead=()=>{f.revoked=true};const response=await artifact(req,ctx());expect(response.status).toBe(401);expect(await response.text()).not.toContain('OWNER_REPORT_CANARY')});
