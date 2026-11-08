import { describe, expect, it, vi } from 'vitest';
import type { AgentTaskRunner } from '../agents/session-service';
import type { ServiceContext } from '../contracts/services';
import type { TextCheckpointStore, CheckpointKey, CheckpointLookup, CheckpointValue } from './integration/checkpoints';
import { createTextEvaluationServices } from './integration/services';
import { makeSuite } from './text/__tests__/fixtures';
import { projectFrozenTextSuite } from './naive-contract-mapping';
import { createNaiveRerunService, type AuthorizedNaiveTextRerun, type NaiveRerunArtifact } from './naive-rerun-service';
import { toContractFinding } from './service-adapter';
function store(): TextCheckpointStore {
  const rows = new Map<string, { key: CheckpointKey; state: CheckpointValue }>();
  const name = (k: CheckpointLookup) => `${k.jobId}:${k.kind}:${k.id}`;
  const get = (k: CheckpointLookup) => { const r = rows.get(name(k)); if (r && k.inputDigest && r.key.inputDigest !== k.inputDigest) throw Error("conflict"); return r; };
  return {
    async claim(k) { const r = get(k); if (r) return structuredClone(r.state); rows.set(name(k), { key: k, state: { state: "pending" } }); return { state: "claimed", token: "token" }; },
    async get(k) { return structuredClone(get(k)?.state ?? null); },
    async complete(k, _token, value) { if (!get(k)) throw Error(); rows.set(name(k), { key: k, state: { state: "completed", value: structuredClone(value) } }); },
    async release(k) { rows.delete(name(k)); },
    async markAmbiguous(k) { rows.set(name(k), { key: k, state: { state: "ambiguous" } }); },
  };
}

async function fixture() {
 const jobId='123e4567-e89b-42d3-a456-426614174000';
 const suite=makeSuite({jobId}); const scope={jobId,customerId:'customer',environment:'test' as const,suiteDigest:suite.digest,approvalArtifactId:'approval'};
 const projection=projectFrozenTextSuite(suite,scope); const checkpoints=store();
 const send=vi.fn(async()=>({ok:true as const,text:'NOT READY',latencyMs:1}));
 const job={jobId,customerId:'customer',environment:'test' as const,package:'text_eval' as const,quoteVersion:null,linkedRetestOf:null,isFixture:true};
 const run=vi.fn(async()=>({status:'completed',taskKey:'relabel',output:{label:'dismissed',quote:'READY',rationale:'The required marker is present.'},session:{sessionId:'ses_relabel',agentId:'investigator',agentVersion:1,consumedMicroUsd:10,tokenUsage:{}},cost:{jobId,source:'naive_session',role:'quality_investigator',externalId:'ses_relabel',microUsd:10,measured:true,purpose:'relabel',recordedAt:'2026-11-07T00:00:00Z'}}));
 const runner={run} as unknown as AgentTaskRunner;
 const ctx:ServiceContext={jobId,environment:'test',budgetMicroUsd:300000,recordCost:vi.fn(),recordProgress:vi.fn()};
 const authority:AuthorizedNaiveTextRerun={job,target:{send},targetVersion:'target-v1',judge:null,knownSecrets:[],scope,retained:projection.retained,baselineRunId:'baseline',runId:'rerun-1',scenarioId:'S01',checkId:'S01.o1',finding:{id:'text:S01:S01.o1',source:'text_eval',category:'explicit_constraint',title:'Marker missing',label:'confirmed',severity:'medium',basis:'objective',summary:'Stored failure',evidence:[{kind:'check',checkId:'S01.o1',detail:'Missing marker'},{kind:'scenario_response',scenarioId:'S01',runId:'baseline',quote:'NO',truncated:false}],investigatorNote:null,reproduction:null}};
 send.mockResolvedValue({ok:true,text:'NO',latencyMs:1});
 const engine=createTextEvaluationServices({runner,checkpoints,resolve:async()=>authority,resolveApprovedSuite:async()=>suite});
 await engine.runSuite(ctx,{suiteDigest:suite.digest,runId:'baseline'}); send.mockClear();send.mockResolvedValue({ok:true,text:'READY',latencyMs:1});
 const artifacts:NaiveRerunArtifact[]=[];const persist=vi.fn(async(_ctx,artifact:NaiveRerunArtifact)=>{artifacts.push(artifact);});
 const resolve=vi.fn(async()=>authority);
 const service=createNaiveRerunService({runner,checkpoints,resolve,persist});
 const input=toContractFinding(authority.finding);
 return {ctx,authority,send,run,service,input,persist,artifacts,resolve};
}
describe('Naive rerun contract',()=>{
 it('executes a durable rerun and has Ines relabel a proven objective pass while retaining original evidence',async()=>{
  const f=await fixture();f.input.description='UNTRUSTED FORGED REQUEST';await expect(f.service.rerunFinding(f.ctx,f.input,undefined)).rejects.toThrow('cannot represent');
  expect(f.artifacts[0]?.relabel?.label).toBe('dismissed');expect(f.send).toHaveBeenCalledTimes(12);
  expect(f.run.mock.calls[0]).toMatchObject([{role:'quality_investigator'}]);
  expect(JSON.stringify(f.run.mock.calls)).not.toContain('UNTRUSTED FORGED REQUEST');
  expect(f.artifacts[0]?.original.label).toBe('confirmed');expect(f.authority.finding.label).toBe('confirmed');
 });
 it('recovers a lost publication without target redispatch and redelivers identical measured receipt',async()=>{
  const f=await fixture();f.persist.mockRejectedValueOnce(Error('ack_lost'));
  await expect(f.service.rerunFinding(f.ctx,f.input,undefined)).rejects.toThrow('ack_lost');
  await expect(f.service.rerunFinding(f.ctx,f.input,undefined)).rejects.toThrow('cannot represent');expect(f.send).toHaveBeenCalledTimes(12);
  expect((f.ctx.recordCost as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual((f.ctx.recordCost as ReturnType<typeof vi.fn>).mock.calls[1]);
 });
 it('refuses wrong lookup identity, cross-customer authority and scenario hints before dispatch',async()=>{
  const f=await fixture();await expect(f.service.rerunFinding(f.ctx,{...f.input,id:'other'},undefined)).rejects.toThrow();
  f.authority.scope.customerId='other';await expect(f.service.rerunFinding(f.ctx,f.input,undefined)).rejects.toThrow();
  f.authority.scope.customerId='customer';await expect(f.service.rerunFinding(f.ctx,f.input,{id:'S02'} as never)).rejects.toThrow();expect(f.send).not.toHaveBeenCalled();
 });
 it('blocks revoked authority before publication',async()=>{
  const f=await fixture();f.persist.mockImplementationOnce(async()=>{f.authority.scope.approvalArtifactId='revoked';});
  await expect(f.service.rerunFinding(f.ctx,f.input,undefined)).rejects.toThrow('mismatch');
 });
 it('does not dismiss missing candidates with infrastructure failure',async()=>{
  const f=await fixture();f.send.mockResolvedValue({ok:false,errorCode:'timeout',message:'unavailable',latencyMs:1} as never);
  await expect(f.service.rerunFinding(f.ctx,f.input,undefined)).rejects.toThrow();expect(f.persist).not.toHaveBeenCalled();expect(f.run).not.toHaveBeenCalled();
 });
 it('rejects invented relabel quotes on objective pass',async()=>{
  const f=await fixture();f.run.mockResolvedValueOnce({status:'completed',output:{label:'dismissed',quote:'invented',rationale:'No'}} as never);
  await expect(f.service.rerunFinding(f.ctx,f.input,undefined)).rejects.toThrow('reconciliation');expect(f.persist).not.toHaveBeenCalled();
 });
 it('binds original finding quotes to the retained baseline before target dispatch',async()=>{
  const f=await fixture();f.authority.finding.evidence=[{kind:'check',checkId:'S01.o1',detail:'failure'},{kind:'scenario_response',scenarioId:'S01',runId:'baseline',quote:'FABRICATED',truncated:false}];
  await expect(f.service.rerunFinding(f.ctx,f.input,undefined)).rejects.toThrow('mismatch');expect(f.send).not.toHaveBeenCalled();
 });
 it('does not send a newly sensitive response to the relabel agent',async()=>{
  const f=await fixture();f.send.mockImplementation(async()=>{f.authority.knownSecrets=['NEW-SENSITIVE'];return {ok:true,text:'READY NEW-SENSITIVE',latencyMs:1};});
  await expect(f.service.rerunFinding(f.ctx,f.input,undefined)).rejects.toThrow();expect(f.run).not.toHaveBeenCalled();expect(f.persist).not.toHaveBeenCalled();
 });
 it('publishes an actual Ines inconclusive decision without misrepresenting dismissal',async()=>{
  const f=await fixture();f.run.mockResolvedValueOnce({status:'completed',output:{label:'inconclusive',quote:'READY',rationale:'A single passing rerun is limited evidence.'}} as never);
  const result=await f.service.rerunFinding(f.ctx,f.input,undefined);expect(result.status).toBe('inconclusive');expect(f.artifacts[0]?.relabel?.label).toBe('inconclusive');expect(f.artifacts[0]?.finding?.label).toBe('inconclusive');
 });
 it('screens a relabel secret rotated during cost settlement before persistence',async()=>{
  const f=await fixture();f.ctx.recordCost=async()=>{f.authority.knownSecrets=['required marker is present'];};
  await expect(f.service.rerunFinding(f.ctx,f.input,undefined)).rejects.toThrow('mismatch');expect(f.persist).not.toHaveBeenCalled();
 });
 it('refuses zero budget before resolving',async()=>{const f=await fixture();await expect(f.service.rerunFinding({...f.ctx,budgetMicroUsd:0},f.input,undefined)).rejects.toThrow('positive');expect(f.resolve).not.toHaveBeenCalled();});
});
