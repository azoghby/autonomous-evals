import {beforeEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({me:{id:'owner',email:'owner@offline.invalid',isOperator:false} as any,action:vi.fn(),load:vi.fn()}));
vi.mock('@/server/queries',()=>({getCurrentCustomer:async()=>h.me,getJobForViewer:h.load}));
vi.mock('@/server/job-actions',()=>({rerunFindingForJob:h.action,submitClarificationAnswer:vi.fn()}));
vi.mock('@/server/create-job',()=>({createJob:vi.fn()}));
vi.mock('@/server/idempotency',()=>({withIdempotency:vi.fn(),IdempotencyInProgressError:class extends Error{}}));
vi.mock('@/server/job-store',()=>({latestQuote:vi.fn(),addMessage:vi.fn()}));
vi.mock('@/workflows/events',()=>({sendJobEvent:vi.fn()}));
vi.mock('@ae/core/payments/checkout',()=>({createCheckoutForQuote:vi.fn(),expireOpenCheckout:vi.fn()}));
vi.mock('@ae/core/payments/stripe',()=>({stripe:vi.fn()}));
vi.mock('@ae/core/db/client',()=>({db:vi.fn(),schema:{}}));
const {POST}=await import('@/app/api/jobs/[jobId]/findings/[findingId]/rerun/route');
const {rerunFinding,TOOLS}=await import('@/server/mcp-tools');
const jobId='11111111-1111-4111-8111-111111111111',findingId='22222222-2222-4222-8222-222222222222';
const caller={customerId:'owner',email:'owner@offline.invalid',origin:'https://offline.invalid'};
beforeEach(()=>{vi.clearAllMocks();h.me={id:'owner',email:caller.email,isOperator:false};h.load.mockResolvedValue({job:{id:jobId,customerId:'owner',state:'delivered'}});h.action.mockImplementation(async(_data,_finding,key,owner)=>key&&owner?{ok:true,value:{operationId:'rerun:fixture',state:'completed',result:{format:'rich_text_rerun.v1'}}}:{ok:false,status:400,error:'Idempotency-Key required'});});
it('actual HTTP and MCP forward identical caller/key to the shared service',async()=>{
 const response=await POST(new Request('https://offline.invalid',{method:'POST',headers:{'Idempotency-Key':'same-key-001'}}),{params:Promise.resolve({jobId,findingId})});expect(response.status).toBe(200);
 const mcp=await rerunFinding(caller,jobId,findingId,'same-key-001');expect(mcp.isError).toBeUndefined();expect(h.action.mock.calls[0]).toEqual(h.action.mock.calls[1]);expect(h.action.mock.calls[0].slice(1)).toEqual([findingId,'same-key-001','owner']);
});
it('old clients without a key get an explicit error and foreign callers never reach dispatch',async()=>{
 expect((await POST(new Request('https://offline.invalid',{method:'POST'}),{params:Promise.resolve({jobId,findingId})})).status).toBe(400);
 expect((await rerunFinding(caller,jobId,findingId)).isError).toBe(true);
 h.action.mockClear();h.load.mockResolvedValue(null);expect((await rerunFinding(caller,jobId,findingId,'same-key-001')).isError).toBe(true);expect(h.action).not.toHaveBeenCalled();
});
it('MCP schema exposes the same safe key syntax and HTTP pending returns 202',async()=>{
 const schema=TOOLS.find(t=>t.name==='rerun_finding')!.inputSchema;expect(schema.safeParse({jobId,findingId,idempotencyKey:'bad key'}).success).toBe(false);expect(schema.safeParse({jobId,findingId,idempotencyKey:'valid-key-001'}).success).toBe(true);
 h.action.mockResolvedValue({ok:true,value:{operationId:'rerun:fixture',state:'pending'}});expect((await POST(new Request('https://offline.invalid',{method:'POST',headers:{'Idempotency-Key':'valid-key-001'}}),{params:Promise.resolve({jobId,findingId})})).status).toBe(202);
});
