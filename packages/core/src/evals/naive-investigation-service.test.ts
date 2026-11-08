import { describe, expect, it, vi } from 'vitest';
import { harness } from '../agents/__tests__/fakes';
import { makeSuite } from './text/__tests__/fixtures';
import { evaluateObjectiveCheck } from './text/objective';
import type { SuiteRun } from './text/schema';
import type { TextCheckpointStore, CheckpointKey, CheckpointLookup, CheckpointValue } from './integration/checkpoints';
import type { ServiceContext } from '../contracts/services';
import { projectFrozenTextSuite, projectTextSuiteRun, type TextContractScope } from './naive-contract-mapping';
import { createNaiveInvestigationService, type AuthorizedNaiveInvestigation } from './naive-investigation-service';
function fixture(failing = false, completed = false) {
  const jobId = '123e4567-e89b-42d3-a456-426614174000', frozen = makeSuite({ jobId });
  const scope: TextContractScope = { jobId, customerId: 'customer', environment: 'test', suiteDigest: frozen.digest, approvalArtifactId: 'approval' };
  const suite = projectFrozenTextSuite(frozen, scope), text = failing ? 'FAIL' : 'READY';
  const run: SuiteRun = { schemaVersion:'text_run.v1',jobId,suiteDigest:frozen.digest,versionLabel:frozen.versionLabel,runId:'run-1',startedAt:frozen.frozenAt,completedAt:frozen.frozenAt,
    executions:frozen.scenarios.map(s=>({scenarioId:s.id,runId:'run-1',attempt:'initial',outcome:'completed',target:{ok:true,errorCode:null,latencyMs:1},responseText:text,responseClipped:false,checks:s.objectiveChecks.map(c=>evaluateObjectiveCheck(c,text)),startedAt:frozen.frozenAt,completedAt:frozen.frozenAt})) };
  const projected = projectTextSuiteRun(run, suite, scope);
  const rows = new Map<string,{key:CheckpointLookup;state:CheckpointValue}>();
  const name=(k:CheckpointLookup)=>`${k.jobId}:${k.kind}:${k.id}`;
  const get=(k:CheckpointLookup)=>{const r=rows.get(name(k));if(r&&k.inputDigest&&r.key.inputDigest!==k.inputDigest)throw Error('conflict');return r;};
  const checkpoints:TextCheckpointStore={async get(k){return structuredClone(get(k)?.state??null);},async claim(k){const r=get(k);if(r)return structuredClone(r.state);rows.set(name(k),{key:k,state:{state:'pending'}});return {state:'claimed',token:'token'};},async complete(k,_t,value){rows.set(name(k),{key:k,state:{state:'completed',value:structuredClone(value)}});},async release(k){rows.delete(name(k));},async markAmbiguous(k){rows.set(name(k),{key:k,state:{state:'ambiguous'}});}};
  const seed=(kind:string,value:unknown)=>{const key={jobId,kind,id:run.runId};rows.set(name(key),{key,state:{state:'completed',value}});};
  seed('run_result',{environment:'test',run});seed('run_identity',{targetVersion:'v1'});
  const send=vi.fn(async()=>({ok:true as const,text:'FAIL',latencyMs:1}));
  const a:AuthorizedNaiveInvestigation={job:{jobId,customerId:'customer',environment:'test',package:'text_eval',quoteVersion:null,linkedRetestOf:null,isFixture:true},target:{send},targetVersion:'v1',judge:null,scope,retainedSuite:suite.retained,retainedRun:projected.retained};
  const h = harness(() => ({ structuredOutput: { reproduceScenarioIds: ['S01'], verdicts: [{candidateId:'text:S01:S01.o1',verdict:'confirmed',rationale:'Repeated failure.',quote:'FAIL',defectNote:null}] } }));
  vi.spyOn(h.service,'run');
  const runner=completed ? h.service : {run:vi.fn(async()=>({status:'pending' as const,retryAfterMs:1000,sessionId:'ses-pending',taskKey:'task',reason:'session_running' as const}))};
  const persist=vi.fn(async()=>{});
  const ctx:ServiceContext={jobId,environment:'test',budgetMicroUsd:1000000,recordCost:vi.fn(),recordProgress:vi.fn()};
  const service=createNaiveInvestigationService({runner,checkpoints,resolve:async()=>a,persistInvestigation:persist});
  return {a,ctx,service,suite,projected,runner,send,persist,seed};
}
describe('Naive investigation contract adapter',()=>{
  it('uses full checkpoint evidence, persists limitations and replays without extra dispatch',async()=>{
    const f=fixture();expect(await f.service.investigate(f.ctx,f.suite.suite,[f.projected.result])).toEqual([]);
    expect(await f.service.investigate(f.ctx,f.suite.suite,[f.projected.result])).toEqual([]);
    expect(f.persist).toHaveBeenCalledTimes(2);expect(f.runner.run).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled();
    expect(f.persist.mock.calls[0]).toBeDefined();
  });
  it('refuses edited booleans, multiple baselines and cross-customer scope before spend',async()=>{
    const f=fixture(true), edited=structuredClone(f.projected.result);edited.results[0]!.passed=true;
    await expect(f.service.investigate(f.ctx,f.suite.suite,[edited])).rejects.toThrow();
    await expect(f.service.investigate(f.ctx,f.suite.suite,[f.projected.result,f.projected.result])).rejects.toThrow();
    f.a.scope.customerId='other';await expect(f.service.investigate(f.ctx,f.suite.suite,[f.projected.result])).rejects.toThrow();expect(f.runner.run).not.toHaveBeenCalled();
  });
  it('checks engine checkpoint baseline and target identity before investigation',async()=>{
    const f=fixture(true);f.seed('run_identity',{targetVersion:'other'});
    await expect(f.service.investigate(f.ctx,f.suite.suite,[f.projected.result])).rejects.toThrow();expect(f.runner.run).not.toHaveBeenCalled();
  });
  it('propagates pending without admitting an immutable incomplete assessment',async()=>{
    const f=fixture(true);await expect(f.service.investigate(f.ctx,f.suite.suite,[f.projected.result])).rejects.toThrow('pending');expect(f.runner.run).toHaveBeenCalledTimes(1);expect(f.persist).not.toHaveBeenCalled();
  });
  it('reauthorizes after persistence before publishing replay',async()=>{
    const f=fixture();f.persist.mockImplementation(async()=>{f.a.scope.approvalArtifactId='revoked';});
    await expect(f.service.investigate(f.ctx,f.suite.suite,[f.projected.result])).rejects.toThrow();
  });
  it('replays measured costs after lost acknowledgement without redispatching agent or target',async()=>{
    const f=fixture(true,true); f.ctx.recordCost=vi.fn().mockRejectedValueOnce(Error('lost acknowledgement')).mockResolvedValue(undefined);
    await expect(f.service.investigate(f.ctx,f.suite.suite,[f.projected.result])).rejects.toThrow('lost acknowledgement');
    const findings=await f.service.investigate(f.ctx,f.suite.suite,[f.projected.result]);
    expect(findings[0]!.status).toBe('confirmed');expect(f.runner.run).toHaveBeenCalledTimes(1);expect(f.send).toHaveBeenCalledTimes(1);
    const calls=vi.mocked(f.ctx.recordCost).mock.calls;expect(calls.length).toBeGreaterThan(1);expect(calls[0]![0]).toEqual(calls[1]![0]);
  });
  it('rejects malformed secret policy and zero budget before dispatch',async()=>{
    const f=fixture(true);f.a.knownSecrets=['abc'];await expect(f.service.investigate(f.ctx,f.suite.suite,[f.projected.result])).rejects.toThrow();
    f.a.knownSecrets=[];await expect(f.service.investigate({...f.ctx,budgetMicroUsd:0},f.suite.suite,[f.projected.result])).rejects.toThrow('positive');expect(f.runner.run).not.toHaveBeenCalled();
  });
});
