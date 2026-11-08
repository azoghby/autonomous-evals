import { beforeEach,describe,expect,it,vi } from 'vitest';
const state=vi.hoisted(()=>({viewer:null as null|{id:string;isOperator:boolean},mutate:vi.fn(),read:vi.fn(),database:vi.fn(()=>({}))}));
vi.mock('./session',()=>({getCurrentCustomer:async()=>state.viewer}));
vi.mock('./automated-expert-owner',()=>({expertOwnerDatabase:state.database}));
vi.mock('./naive-remediation-policy',async original=>({...await original<typeof import('./naive-remediation-policy')>(),mutateNaiveRemediationTrialPolicy:state.mutate,readNaiveRemediationPolicyStatus:state.read}));
import { GET,POST } from '@/app/api/operator/jobs/[id]/remediation-policy/route';
const id='123e4567-e89b-42d3-a456-426614174000',operatorId='323e4567-e89b-42d3-a456-426614174000';
const input={action:'issue',targetVersion:'a'.repeat(64),kind:'stateless_chat_completions',isolation:'request_messages_only',declaresStateless:true,operationMicroUsd:100};
const context={params:Promise.resolve({id})};
function request(body:unknown=input,headers:Record<string,string>={}){return new Request('https://app.example.test/api/operator/jobs/'+id+'/remediation-policy',{method:'POST',headers:{origin:'https://app.example.test','content-type':'application/json','sec-fetch-site':'same-origin',...headers},body:typeof body==='string'?body:JSON.stringify(body)});}
beforeEach(()=>{state.viewer={id:operatorId,isOperator:true};state.mutate.mockReset();state.read.mockReset();state.database.mockClear();state.read.mockResolvedValue({status:'not_configured'});});
describe('operator remediation policy route',()=>{
 it('denies anonymous and nonoperator reads and writes before database access',async()=>{
  for(const viewer of [null,{id:operatorId,isOperator:false}]){state.viewer=viewer;const expected=viewer?403:401;expect((await GET(request(),context)).status).toBe(expected);expect((await POST(request(),context)).status).toBe(expected);}
  expect(state.database).not.toHaveBeenCalled();expect(state.mutate).not.toHaveBeenCalled();
 });
 it('uses authenticated operator identity and marks responses private',async()=>{
  const get=await GET(request(),context);expect(get.status).toBe(200);expect(get.headers.get('cache-control')).toContain('no-store');expect(state.read).toHaveBeenCalledWith({},id,operatorId);
  expect((await POST(request(),context)).status).toBe(200);expect(state.mutate).toHaveBeenCalledWith({},id,operatorId,input);
 });
 it('rejects CSRF, unsupported content type, malformed and oversized JSON',async()=>{
  for(const headers of [{origin:'https://evil.example.test'},{origin:''},{'sec-fetch-site':'cross-site'}])expect((await POST(request(input,headers),context)).status).toBe(403);
  expect((await POST(request(input,{'content-type':'text/plain'}),context)).status).toBe(415);
  expect((await POST(request('{'),context)).status).toBe(400);
  expect((await POST(request({...input,declaresStateless:false}),context)).status).toBe(400);
  expect((await POST(request({...input,arbitrary:'x'.repeat(3000)}),context)).status).toBe(413);
  expect(state.mutate).not.toHaveBeenCalled();expect(state.database).not.toHaveBeenCalled();
 });
 it('validates job ids and surfaces canonical authority conflicts',async()=>{
  const invalid={params:Promise.resolve({id:'bad'})};expect((await GET(request(),invalid)).status).toBe(400);expect((await POST(request(),invalid)).status).toBe(400);
  state.read.mockRejectedValue(Error('revoked'));state.mutate.mockRejectedValue(Error('revoked'));expect((await GET(request(),context)).status).toBe(409);expect((await POST(request(),context)).status).toBe(409);
 });
});
