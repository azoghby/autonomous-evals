import {it,expect,vi,beforeEach} from 'vitest';
import {evidence,suite} from './fixture';
import {attachWorkflowPackEvidence} from './apps/web/src/server/workflow-pack-projection';
const m=vi.hoisted(()=>({me:vi.fn(),viewer:vi.fn(),job:vi.fn(),loaded:vi.fn(),read:vi.fn(),text:vi.fn()}));
vi.mock('@/server/http',()=>({jsonError:(status:number,error:string)=>Response.json({error},{status})}));
vi.mock('@/server/queries',()=>({getCurrentCustomer:m.me,getJobForViewer:m.viewer}));
vi.mock('@/server/job-store',()=>({getJob:m.job,getJobWithDecryptedCredentials:m.loaded}));
vi.mock('@/server/rich-services',()=>({workflowSql:()=>({})}));
vi.mock('@/server/rich-artifacts',()=>({readRichArtifact:m.read}));
vi.mock('@ae/core/storage/blob',()=>({readJobArtifact:vi.fn(),readJobArtifactText:m.text}));
import {GET} from './apps/web/src/app/api/jobs/[jobId]/artifacts/[kind]/route';
const call=(kind:string)=>GET(new Request(`https://app.invalid/api/jobs/job/artifacts/${kind}`),{params:Promise.resolve({jobId:'job',kind})});
beforeEach(()=>{vi.resetAllMocks();m.me.mockResolvedValue({id:'viewer'});m.viewer.mockResolvedValue({job:{}});m.job.mockResolvedValue({customerId:'owner',reportBlobPath:'report.md'});m.loaded.mockResolvedValue({credentials:{endpoint:'rotated-secret'}});m.read.mockResolvedValue(attachWorkflowPackEvidence({suite},evidence()));m.text.mockResolvedValue('Existing report');});
it('projects pack scope into actual markdown and HTML downloads',async()=>{
 for(const kind of ['report','report-html']){const res=await call(kind);expect(res.status).toBe(200);expect(res.headers.get('cache-control')).toBe('private, no-store');const text=await res.text();expect(text).toContain('rt_unknown_case');expect(text).toContain('quarantined');expect(text).not.toContain('PRIVATE_RESPONSE');}
});
it('exports separate safe progress and complete private evidence',async()=>{
 const progress=await call('pack-progress');expect(progress.status).toBe(200);expect((await progress.json()).appendedPack.cases).toHaveLength(3);
 const raw=await call('evidence');expect(await raw.text()).toContain('PRIVATE_RESPONSE');
 expect(m.read.mock.calls[0].slice(1)).toEqual(['job','owner',['rotated-secret']]);
});
it('denies anonymous and unauthorized progress before reading private storage',async()=>{
 m.me.mockResolvedValue(null);expect((await call('pack-progress')).status).toBe(401);expect(m.read).not.toHaveBeenCalled();
 m.me.mockResolvedValue({id:'other'});m.viewer.mockResolvedValue(null);expect((await call('report')).status).toBe(404);expect(m.read).not.toHaveBeenCalled();
});
it('fails closed on redaction or malformed retained evidence for every projection route',async()=>{
 for(const kind of ['report','report-html','pack-progress']){m.read.mockRejectedValue(new Error('secret'));expect((await call(kind)).status).toBe(409);}
 m.read.mockResolvedValue({appendedPack:null});expect((await call('report')).status).toBe(409);
});
it('retains legacy report behavior and unknown absence of pack progress',async()=>{
 m.read.mockResolvedValue({format:'rich_text.v1'});expect((await call('pack-progress')).status).toBe(404);
 expect(await (await call('report-html')).text()).toContain('Existing report');
});
