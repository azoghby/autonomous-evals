import {describe,it,expect,vi,beforeEach} from 'vitest';
const f=vi.hoisted(()=>({denied:null as Response|null,query:vi.fn(),compare:vi.fn(),dispose:vi.fn(),owner:vi.fn(),job:vi.fn(),production:vi.fn()}));
vi.mock('../apps/web/src/app/api/cron/_auth',()=>({requireCronAuth:()=>f.denied}));
vi.mock('@/server/rich-services',()=>({workflowSql:()=>({query:f.query})}));
vi.mock('@/server/comparison-production',()=>({comparisonProduction:f.production}));
vi.mock('@/server/job-store',()=>({makeServiceContext:async()=>({jobId:'job'}),getJob:f.job}));
vi.mock('@/server/queries',()=>({getCurrentCustomer:f.owner}));
vi.mock('@/server/http',()=>({isUuid:()=>true}));
import {GET as cron} from '../apps/web/src/app/api/cron/monitoring/route';
import {GET as read} from '../apps/web/src/app/api/jobs/[jobId]/comparison/route';
beforeEach(()=>{vi.clearAllMocks();f.denied=null;f.production.mockResolvedValue({app:{compare:f.compare},dispose:f.dispose});});
describe('actual private/cron route entrypoints with offline application dependencies',()=>{
 it('rejects cron auth before application access',async()=>{f.denied=new Response('denied',{status:401});expect((await cron(new Request('https://local.test'))).status).toBe(401);expect(f.query).not.toHaveBeenCalled();expect(f.production).not.toHaveBeenCalled();});
 it('derives identical subscription/day operation IDs across cron retries and never sends',async()=>{
  const v={version:'v1',targetId:'t1',branchId:null,configurationDigest:'a'.repeat(64),endpointSlot:'endpoint'};
  f.query.mockResolvedValue({rows:[{id:'subscription',job_id:'job',customer_id:'tenant',binding:{suiteId:'frozen',scope:'base12',scenarioIds:[],baseline:v,current:{...v,version:'v2'},targetCallMicroUsd:1,jobCapMicroUsd:3}}]});
  const a=await cron(new Request('https://local.test')),b=await cron(new Request('https://local.test'));
  expect((await a.json()).sent).toBe(0);expect((await b.json()).sent).toBe(0);
  expect(f.compare.mock.calls[0][2].operationId).toBe(f.compare.mock.calls[1][2].operationId);expect(f.compare.mock.calls[0][2].operationId).toMatch(/^monitor:subscription:\d{4}-\d{2}-\d{2}$/);expect(f.dispose).toHaveBeenCalledTimes(2);
 });
 it('rejects another customer before creating an artifact reader',async()=>{f.owner.mockResolvedValue({id:'intruder'});f.job.mockResolvedValue({customerId:'owner',environment:'test'});expect((await read(new Request('https://local.test?operationId=tick'),{params:Promise.resolve({jobId:'job'})})).status).toBe(404);expect(f.production).not.toHaveBeenCalled();});
});
