import { describe,it,expect,vi } from 'vitest';
vi.mock('./session',()=>({getSessionToken:vi.fn(async()=> 'token')}));
vi.mock('@ae/core/auth/magic-link',()=>({customerForSessionToken:vi.fn(async()=>({id:'owner',email:'owner@example.test'}))}));
vi.mock('@ae/core/auth/tokens',()=>({isOperator:vi.fn(()=>false)}));
import {reviewDigest} from '@ae/core/evals/data/binding';
import {createSourcingApiDependencies,freshSourcingViewer} from './expert-sourcing-runtime-dependencies';
import {getSessionToken} from './session';
import {customerForSessionToken} from '@ae/core/auth/magic-link';
import type {AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
import type {withSourcingLocks} from './expert-sourcing-locks';
const viewer=async()=>({id:'owner',email:'owner@example.test',isOperator:false});
function fixture(consented=true){
 const queries:string[]=[],keys:string[][]=[];
 const job={customer_id:'owner',environment:'test',intake:{invalid:'changed'},package:'text_eval',is_mock:false,state:'running',before_deadline:true,credentials_current:true,deadline:'2030-01-01'};
 const query=vi.fn(async(text:string)=>{queries.push(text);
  if(text.includes('FROM jobs'))return {rows:[job]};
  if(text.includes('SELECT id,topic,consent_version'))return {rows:consented?[{id:'consent',topic:'medicine',expires_at:'2030-01-01',canonical_input_digest:'old'}]:[]};
  if(text.includes('SELECT id,topic,max_requirements'))return {rows:[{id:'policy',topic:'medicine'}]};
  if(text.includes('UPDATE expert_sourcing.consents'))return {rows:[{id:'consent'}]};
  return {rows:[]};
 });
 const db={query,transaction:async(fn:any)=>fn({query})} as unknown as AgentTransactionalSql;
 const locks=(async(k:string[],fn:any)=>{keys.push(k);return fn(async()=>{});}) as typeof withSourcingLocks;
 return {deps:createSourcingApiDependencies(db,viewer,locks),queries,keys,job,query};
}
describe('sourcing production adapter',()=>{
 it('reads token/session anew on every viewer call',async()=>{await freshSourcingViewer();await freshSourcingViewer();expect(getSessionToken).toHaveBeenCalledTimes(2);expect(customerForSessionToken).toHaveBeenCalledTimes(2);});
 it('owner may revoke after input becomes invalid, under job mutex only',async()=>{
  const f=fixture();await f.deps.revokeConsent({jobId:'job',customerId:'owner',currentCustomer:async()=> 'owner'});
  expect(f.keys).toEqual([['expert-sourcing:job:job']]);expect(f.queries.some(q=>q.startsWith('UPDATE expert_sourcing.consents'))).toBe(true);
  expect(f.queries.some(q=>q.includes('job_credentials'))).toBe(false);
 });
 it('fresh callback loss blocks revocation before writes',async()=>{
  const f=fixture();await expect(f.deps.revokeConsent({jobId:'job',customerId:'owner',currentCustomer:async()=>null})).rejects.toThrow('Authentication changed');
  expect(f.queries).toEqual([]);
 });
 it('shows input_changed while retaining revocable consent metadata',async()=>{
  const f=fixture();expect(await f.deps.getSharingStatus({jobId:'job',customerId:'owner'})).toMatchObject({status:'input_changed',topic:'medicine'});
 });
 it('offers configured topics only with retained factual selection',async()=>{
  vi.stubEnv('EVAL_SERVICES','real');
  const f=fixture(false);
  f.job.intake={package:'text_eval',authorizedToTest:true,endpoint:{url:'https://example.test/v1',model:'test',systemPrompt:'Answer accurately'}} as any;
  const value={schemaVersion:'naive_text_execution_selection.v1',identity:{jobId:'job',customerId:'owner',environment:'test'},profile:{policyId:'generic-text-factual-gap-v1',designId:'generic-text-factual-gap-v1',versionLabel:'generic-text-factual-gap-v1',admissionPolicyId:'automated-text-design-factual-gap-v1',factualGapPolicy:'propose_missing_reference.v1',expertTaskId:'task'}};
  const original=f.query.getMockImplementation()!;
  f.query.mockImplementation(async text=>text.includes('text_integration.checkpoints')?{rows:[{state:'completed',input_digest:reviewDigest(value),value}]} as any:original(text));
  expect(await f.deps.getSharingStatus({jobId:'job',customerId:'owner'})).toMatchObject({status:'not_consented',eligibleTopics:['medicine']});
  vi.unstubAllEnvs();
 });
 it.each(['trace','mock','invalid','nonselected'])('does not offer consent for %s jobs without existing consent',async kind=>{
  vi.stubEnv('EVAL_SERVICES','real');
  const f=fixture(false);
  if(kind==='trace')f.job.package='trace_audit';
  if(kind==='mock')f.job.is_mock=true;
  if(kind==='nonselected')f.job.intake={package:'text_eval',authorizedToTest:true,endpoint:{url:'https://example.test/v1',model:'test',systemPrompt:'Answer accurately'}} as any;
  expect(await f.deps.getSharingStatus({jobId:'job',customerId:'owner'})).toMatchObject({status:'not_consented',eligibleTopics:[]});
  if(kind==='nonselected')expect(f.queries.some(q=>q.includes('text_integration.checkpoints'))).toBe(true);
  vi.unstubAllEnvs();
 });
 it('operator mutation rechecks actual operator state',async()=>{
  const f=fixture();await expect(f.deps.revokePolicy({policyId:'policy',reason:'stop',currentOperator:async()=> 'owner'})).rejects.toThrow('Operator access required');
  expect(f.keys).toEqual([['expert-sourcing:policy:policy']]);expect(f.queries).toEqual([]);
 });
});
