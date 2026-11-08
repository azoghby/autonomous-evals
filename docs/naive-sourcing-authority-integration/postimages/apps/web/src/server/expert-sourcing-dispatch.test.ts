import { beforeEach,describe,expect,it,vi } from 'vitest';
import { reviewDigest } from '@ae/core/evals/data/binding';
const gate=vi.hoisted(()=>({current:vi.fn(),discover:vi.fn(),held:false,healthy:true,events:[] as string[],onAcquire:undefined as undefined|(()=>void)}));
vi.mock('./expert-sourcing-bridge',()=>({assertDerivedSourcingAuthorityCurrent:gate.current,discoverSourcingLockKeys:gate.discover}));
vi.mock('./expert-sourcing-locks',()=>({withSourcingLocks:async(keys:string[],work:(assert:()=>Promise<void>)=>Promise<unknown>)=>{expect(keys).toEqual(['policy','job']);gate.held=true;gate.events.push('lock');gate.onAcquire?.();try{return await work(async()=>{gate.events.push('health');if(!gate.healthy)throw Error('lost');});}finally{gate.events.push('unlock');gate.held=false;}}}));
vi.mock('@ae/core/evals/data/adapters/postgres-expert-loop',()=>({createPostgresExpertLoopStore:()=>({get:async()=>null}),createExpertPromiseReservation:vi.fn()}));
import { approveSqlManagedExpertDraft, createSqlExpertOwner } from './automated-expert-owner';
const scope={jobId:'job',taskId:'task',operationId:'operation',requestHash:'hash'};
const inv={requestId:'operation',contactId:'expert',questions:['A factual question?'],requiredUses:['evaluation'],honorariumMicroUsd:25000000,sharesCustomerScope:true};
function fixture(kind='derived_standing_policy',factual=true){
 let state='prepared',contact=true,body='Bounded invitation';
 const sql:any={transaction:async(fn:any)=>{gate.events.push('transaction');return fn(sql);},query:async(q:string)=>{
  let rows:any[]=[];
  if(q.includes('coalesce(p.input'))rows=[{authority_kind:kind,factual}];
  else if(q.includes('coalesce(o.first_promise_day'))rows=[{policy_id:'caps',customer_sharing_consent:true,day_scope:'2026-11-08'}];
  else if(q.includes('SELECT e.*,q.allowed_uses'))rows=contact?[{id:'expert',email:'expert@example.com',name:'Expert',source:'opt_in',consent_flags:{contactForPaidWork:true},allowed_uses:['evaluation']}]:[];
  else if(q.includes('SELECT * FROM expert_automation_operations'))rows=[{...{job_id:'job',task_id:'task',tenant_id:'tenant',request_hash:'hash'},request_id:'request'}];
  else if(q.includes('SELECT i.*,d.subject'))rows=[{engagement_id:'engagement',draft_id:'draft',invitation_digest:reviewDigest(inv),promised:true,promise_key:'promise',founder_approved_by:null,send_state:state,subject:'Invitation',body,status:'pending',to_email:'expert@example.com',engagement_status:'invited'}];
  else if(q.includes("SET send_state='claimed'")){state='claimed';gate.events.push('claim');}
  else if(q.includes("SET send_state='sent'")){expect(gate.held||kind==='legacy_configured').toBe(true);gate.events.push('record');state='sent';}
  return {rows};
 }};
 const sendEmail=vi.fn(async()=>{expect(gate.held||kind==='legacy_configured').toBe(true);gate.events.push('provider');return {id:'message'};});
 const owner=createSqlExpertOwner(sql,{scope,tenantId:'tenant',topic:'Topic',appUrl:'https://example.com',companyAddress:'Address',ledger:vi.fn() as any,contributions:async()=>[],sendEmail});
 return {owner,sendEmail,revokeContact:()=>{contact=false;},changeDraft:()=>{body='Changed';},state:()=>state};
}
beforeEach(()=>{vi.clearAllMocks();gate.held=false;gate.healthy=true;gate.events=[];gate.onAcquire=undefined;gate.current.mockResolvedValue(undefined);gate.discover.mockResolvedValue({policyId:'policy',keys:['policy','job']});});
describe('candidate managed dispatch ordering (fake provider)',()=>{
 it('holds policy then job mutex through full recheck, provider completion and status recording',async()=>{const f=fixture();expect(await f.owner.invite(scope,inv,'promise')).toEqual({status:'sent',deliveryId:'engagement'});expect(gate.current).toHaveBeenCalledTimes(2);expect(gate.events.filter(e=>['lock','claim','health','provider','record','unlock'].includes(e))).toEqual(['lock','claim','health','provider','record','unlock']);});
 it('revocation winning acquisition blocks before claim or provider',async()=>{const f=fixture();gate.onAcquire=()=>gate.current.mockRejectedValue(Error('revoked'));await expect(f.owner.invite(scope,inv,'promise')).rejects.toThrow('revoked');expect(f.state()).toBe('prepared');expect(f.sendEmail).not.toHaveBeenCalled();});
 it('rejects canonical policy drift after acquisition',async()=>{const f=fixture();gate.discover.mockResolvedValueOnce({policyId:'first',keys:['policy','job']});await expect(f.owner.invite(scope,inv,'promise')).rejects.toThrow();expect(f.sendEmail).not.toHaveBeenCalled();});
 it('lock loss immediately before dispatch leaves claim ambiguous without provider call',async()=>{const f=fixture();gate.healthy=false;expect(await f.owner.invite(scope,inv,'promise')).toEqual({status:'ambiguous'});expect(f.state()).toBe('claimed');expect(f.sendEmail).not.toHaveBeenCalled();});
 it.each(['contact','draft','authority'])('final %s change blocks a claimed invitation',async change=>{const f=fixture();gate.current.mockImplementationOnce(async()=>{}).mockImplementationOnce(async()=>{if(change==='contact')f.revokeContact();if(change==='draft')f.changeDraft();if(change==='authority')throw Error('revoked');});expect(await f.owner.invite(scope,inv,'promise')).toEqual({status:'ambiguous'});expect(f.sendEmail).not.toHaveBeenCalled();});
 it('never retries a claimed invitation after an ambiguous provider outcome',async()=>{const f=fixture();f.sendEmail.mockRejectedValueOnce(Error('timeout'));expect(await f.owner.invite(scope,inv,'promise')).toEqual({status:'ambiguous'});expect(await f.owner.invite(scope,inv,'promise')).toEqual({status:'ambiguous'});expect(f.sendEmail).toHaveBeenCalledTimes(1);});
 it('preserves explicit nonfactual legacy behavior',async()=>{const f=fixture('legacy_configured',false);expect(await f.owner.invite(scope,inv,'promise')).toMatchObject({status:'sent'});expect(gate.current).not.toHaveBeenCalled();expect(gate.discover).not.toHaveBeenCalled();});
 it('factual metadata cannot use the legacy discriminator to omit current authority',async()=>{const f=fixture('legacy_configured',true);gate.current.mockRejectedValue(Error('missing-grant'));await expect(f.owner.invite(scope,inv,'promise')).rejects.toThrow('missing-grant');expect(f.sendEmail).not.toHaveBeenCalled();});
 it('rejects an absent discriminator',async()=>{const f=fixture('',false);await expect(f.owner.invite(scope,inv,'promise')).rejects.toThrow();expect(f.sendEmail).not.toHaveBeenCalled();});
 it('denies request creation after derived revocation before any write',async()=>{const f=fixture();gate.current.mockRejectedValue(Error('revoked'));await expect(f.owner.ensureRequest(scope)).rejects.toThrow('revoked');expect(f.sendEmail).not.toHaveBeenCalled();});
 it('managed founder approval checks current derived authority before mutation',async()=>{
  const writes:string[]=[];const sql:any={transaction:async(fn:any)=>fn(sql),query:async(q:string)=>{
   if(q.includes('SELECT i.draft_id,o.job_id'))return {rows:[{draft_id:'draft',job_id:'job',task_id:'task'}]};
   if(q.includes('coalesce(p.input'))return {rows:[{authority_kind:'derived_standing_policy',factual:true}]};
   if(!q.startsWith('SELECT'))writes.push(q);return {rows:[]};
  }};
  vi.stubEnv('OPERATOR_EMAILS','operator@example.com');
  try{gate.current.mockRejectedValue(Error('revoked'));await expect(approveSqlManagedExpertDraft(sql,'draft','operator@example.com')).rejects.toThrow('revoked');expect(writes).toEqual([]);}finally{vi.unstubAllEnvs();}
 });

});
