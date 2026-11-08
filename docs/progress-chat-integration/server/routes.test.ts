import { beforeEach, describe, it, expect, vi } from 'vitest';
import { ChatError, createProgressChatService } from '@ae/core/reporting/chat/index';
const makeService = vi.hoisted(()=>vi.fn());
vi.mock('@chat-server',()=>({progressChatForRequest:makeService}));
import { GET, POST } from '@chat-route';
const jobId='11111111-1111-4111-8111-111111111111';
const ctx={params:Promise.resolve({jobId})};
const url='https://app.example/api/jobs/'+jobId+'/chat';
const post=(body:unknown,origin='https://app.example')=>new Request(url,{method:'POST',headers:{origin},body:JSON.stringify(body)});
beforeEach(()=>{makeService.mockReset();});
describe('authenticated private route',()=>{
  it.each([['unauthenticated',401],['not_found',404],['storage_error',503]])('safe %s failure',async(code,status)=>{
    makeService.mockRejectedValue(new ChatError(code as never));
    const res=await GET(new Request(url),ctx);expect(res.status).toBe(status);expect(res.headers.get('cache-control')).toContain('no-store');
  });
  it('suppresses unknown exception messages',async()=>{
    makeService.mockRejectedValue(new Error('password=private-secret'));
    expect(await (await GET(new Request(url),ctx)).text()).not.toContain('private-secret');
  });
  it('enforces same-origin and rejects caller identity',async()=>{
    expect((await POST(post({messageId:'a',text:'progress'},'https://evil.example'),ctx)).status).toBe(400);
    expect(makeService).not.toHaveBeenCalled();
    const send=vi.fn();makeService.mockResolvedValue({send});
    expect((await POST(post({messageId:'a',text:'progress',subjectId:'victim'}),ctx)).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
  it('maps pagination and poll to distinct read-only methods',async()=>{
    const history=vi.fn(async()=>({messages:[],nextAfterSequence:20}));const poll=vi.fn(async()=>({changed:false,cursor:'a'.repeat(64),asOf:'2026-11-07T00:00:00Z'}));const send=vi.fn();
    makeService.mockResolvedValue({history,poll,send});
    expect(await (await GET(new Request(url+'?afterSequence=20&limit=20'),ctx)).json()).toEqual({exchanges:[],nextAfterSequence:20,hasMore:false});
    await GET(new Request(url+'?mode=poll&cursor='+'a'.repeat(64)),ctx);expect(poll).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled();
    expect((await GET(new Request(url+'?limit=1e2'),ctx)).status).toBe(400);
  });
  it('uses real core authorization, private scope, replay and read-only poll while running/after delivery',async()=>{
    const saved = new Map(); let reads=0; let appends=0; let authorized=true; let status='running';
    const snapshot=()=>({jobId,observedAt:'2026-11-07T00:00:00Z',status,statusEvidenceRef:'ev_status',milestones:[],findings:[],blockers:[],costs:[],unknownCosts:true});
    makeService.mockImplementation(async()=>createProgressChatService({access:{authenticate:async()=>({subjectId:'owner'}),resolveAuthorizedJob:async()=>authorized?{subjectId:'owner',jobId}:null},progress:{read:async()=>{reads++;return snapshot() as never;}},conversations:{get:async(scope,id)=>saved.get(scope.subjectId+scope.jobId+id)??null,append:async(scope,input)=>{appends++;const v={...input,sequence:appends};saved.set(scope.subjectId+scope.jobId+input.messageId,v);return v;},list:async()=>[...saved.values()]},knownSecrets:[]}));
    const one=await (await POST(post({messageId:'same',text:'progress'}),ctx)).json();
    const two=await (await POST(post({messageId:'same',text:'progress'}),ctx)).json();expect(two).toEqual(one);expect(appends).toBe(1);
    expect((await POST(post({messageId:'same',text:'cost'}),ctx)).status).toBe(409);
    status='delivered';await GET(new Request(url+'?mode=poll'),ctx);await GET(new Request(url),ctx);expect(appends).toBe(1);expect(reads).toBe(2);
    authorized=false;expect((await GET(new Request(url),ctx)).status).toBe(404);expect((await POST(post({messageId:'new',text:'progress'}),ctx)).status).toBe(404);
  });
});
