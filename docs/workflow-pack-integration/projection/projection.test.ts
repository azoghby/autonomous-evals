import {expect,it} from 'vitest';
import {evidence,suite} from './fixture';
import type {PackRunEvidence} from './packages/core/src/evals/packs/index';
import {executeSuite} from './packages/core/src/evals/text/execute';
import {evaluateObjectiveCheck} from './packages/core/src/evals/text/objective';
import {projectWorkflowPack, containsWorkflowPackArtifactSecret, retainedWorkflowPackBaseline, attachWorkflowPackEvidence, workflowPackFromArtifact, appendWorkflowPackReport} from './apps/web/src/server/workflow-pack-projection';
const draft={scenarioIds:evidence().pack.expectedIds};
it('retains every accepted and quarantined ID despite forged aggregate pass claims',()=>{
 const p=projectWorkflowPack(evidence());expect(p.appendedPack.cases.map(c=>c.status)).toEqual(['pass','quarantined','quarantined']);expect(p.base12.status).toBe('unknown');expect(p.fullScope.passed).toBe(false);
 expect(p.remediation).toEqual({scope:'base12_only',certifiesPack:false});
});
it('missing, partial and unknown case checks never pass',()=>{
 const e=evidence();e.pack.results=[];expect(projectWorkflowPack(e).appendedPack.cases[0]!.status).toBe('unknown');
 e.pack.results=evidence().pack.results;e.pack.results[0]!.checks=[];expect(projectWorkflowPack(e).appendedPack.cases[0]!.status).toBe('unknown');
 e.pack.results=evidence().pack.results;e.pack.results[0]!.checks[0]!.status='not_assessed';expect(projectWorkflowPack(e).fullScope.passed).toBe(false);
});
it('rejects changed manifest, partial inventory, duplicate and foreign results',()=>{
 for(const mutate of [(e:PackRunEvidence)=>{e.pack.expectedIds=[]},(e:PackRunEvidence)=>{e.pack.results.push(e.pack.results[0]!)},(e:PackRunEvidence)=>{e.pack.results[0]!.id='rt_foreign'},(e:PackRunEvidence)=>{e.context.targetConfigDigest='b'.repeat(64)}]){
  const e=evidence();mutate(e);expect(()=>projectWorkflowPack(e)).toThrow();
 }
});
it('preserves full raw evidence privately with independent scopes and no mutation',()=>{
 const e=evidence();const body=attachWorkflowPackEvidence({format:'rich_text.v1',suite,investigation:{private:'PRIVATE_INVESTIGATION'}},e);
 expect(workflowPackFromArtifact(body)).toEqual(e);expect(body.investigation.private).toBe('PRIVATE_INVESTIGATION');
 body.appendedPack.pack.results=[];expect(e.pack.results).toHaveLength(1);
 expect(()=>attachWorkflowPackEvidence({suite:{digest:'b'.repeat(64)}},e)).toThrow();
 expect(workflowPackFromArtifact({format:'rich_text.v1'})).toBeNull();
});
it('reports all expected cases without private responses, specs or untrusted reasons',()=>{
 const e=evidence();e.pack.results[0]!.reason='<script>PRIVATE_REASON</script>';
 const md=appendWorkflowPackReport('Existing report',e);for(const id of draft.scenarioIds)expect(md).toContain(id);
 expect(md).toContain('Base12 remediation cannot certify appended cases');expect(md).not.toMatch(/PRIVATE|<script>/);
});
it('keeps a passed base12 independent from quarantined appended scope',async()=>{
 const e=evidence();e.base.run=await executeSuite(suite,'base-run',{target:{send:async()=>({ok:true,text:'READY',latencyMs:1})},judge:null,evaluateObjective:evaluateObjectiveCheck});
 const p=projectWorkflowPack(e);expect(p.base12.status).toBe('pass');expect(p.appendedPack.status).toBe('quarantined');expect(p.fullScope.passed).toBe(false);
 expect(p.baseline).toEqual({runId:'base-run',digest:suite.digest});
});
it('retains failure precedence with simultaneous coverage gaps',()=>{
 const e=evidence();e.pack.results[0]!.checks[0]!.status='fail';const p=projectWorkflowPack(e);
 expect(p.fullScope.status).toBe('fail');expect(p.appendedPack.cases.filter(c=>c.status==='quarantined')).toHaveLength(2);
});

it('binds a retained baseline to complete private evidence rather than base12 digest',()=>{
 const body=attachWorkflowPackEvidence({suite,investigation:{detail:'one'}},evidence());
 const baseline=retainedWorkflowPackBaseline(body);
 expect(baseline.runId).toBe('pack-run');expect(baseline.digest).not.toBe(suite.digest);
 body.investigation.detail='two';expect(retainedWorkflowPackBaseline(body).digest).not.toBe(baseline.digest);
 expect(()=>retainedWorkflowPackBaseline({suite})).toThrow();
});

it('scans structured authorization metadata without dropping known secrets or credential payloads',()=>{
 const body=attachWorkflowPackEvidence({suite},evidence());
 expect(containsWorkflowPackArtifactSecret(body,[])).toBe(false);
 expect(containsWorkflowPackArtifactSecret(body,['reviewed'])).toBe(true);
 expect(containsWorkflowPackArtifactSecret({...body, other:{authorization:'Bearer abcdefghijklmnop'}},[])).toBe(true);
 expect(containsWorkflowPackArtifactSecret({...body, other:{password:'credential-value'}},[])).toBe(true);
});
