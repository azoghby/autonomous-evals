import {it,expect,vi,beforeEach} from 'vitest';
const m=vi.hoisted(()=>({me:vi.fn(),viewer:vi.fn(),job:vi.fn(),loaded:vi.fn(),read:vi.fn()}));
vi.mock('@/server/http',()=>({jsonError:(status:number,error:string)=>Response.json({error},{status})}));
vi.mock('@/server/queries',()=>({getCurrentCustomer:m.me,getJobForViewer:m.viewer}));
vi.mock('@/server/job-store',()=>({getJob:m.job,getJobWithDecryptedCredentials:m.loaded}));
vi.mock('@/server/rich-services',()=>({workflowSql:()=>({})}));
vi.mock('@/server/rich-artifacts',()=>({readRichArtifact:m.read}));
vi.mock('@ae/core/storage/blob',()=>({readJobArtifact:vi.fn(),readJobArtifactText:vi.fn()}));
import {GET} from '@artifact-route';
const call=()=>GET(new Request('https://app.invalid/api/jobs/job/artifacts/evidence'),{params:Promise.resolve({jobId:'job',kind:'evidence'})});
beforeEach(()=>{vi.resetAllMocks();m.me.mockResolvedValue({id:'viewer'});m.viewer.mockResolvedValue({job:{}});m.job.mockResolvedValue({customerId:'owner'});m.loaded.mockResolvedValue({credentials:{endpoint:'rotated-secret'}});m.read.mockResolvedValue({status:'unresolved'});});
it('actual evidence route denies anonymous and other-owner callers before private reads',async()=>{
 m.me.mockResolvedValue(null);expect((await call()).status).toBe(401);expect(m.read).not.toHaveBeenCalled();expect(m.job).not.toHaveBeenCalled();
 m.me.mockResolvedValue({id:'other'});m.viewer.mockResolvedValue(null);expect((await call()).status).toBe(404);expect(m.read).not.toHaveBeenCalled();expect(m.loaded).not.toHaveBeenCalled();
});
it('actual evidence route passes current secrets and owner to private reader and fails closed on refusal',async()=>{
 const res=await call();expect(res.status).toBe(200);expect(res.headers.get('cache-control')).toBe('private, no-store');expect(m.read.mock.calls[0].slice(1)).toEqual(['job','owner',['rotated-secret']]);
 m.read.mockRejectedValue(new Error('opaque-secret'));expect((await call()).status).toBe(409);expect(await (await call()).text()).not.toContain('opaque-secret');
});
