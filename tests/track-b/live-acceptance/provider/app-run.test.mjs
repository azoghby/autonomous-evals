import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEvidence, operationPlan, main, TEXT_DIGEST, EVIDENCE_SCHEMA, CAPS } from './app-run.mjs';
// Synthetic contract samples only. They are never emitted as live acceptance.
const fixture = () => {
  const ids = Array.from({ length: 12 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
  const run = (runId, suiteDigest, scenarioIds, failed) => ({runId,suiteDigest,scenarioIds,passed:scenarioIds.length-failed,productFailures:failed,inconclusive:0});
  const calendar = {suiteDigest:'c'.repeat(64), reviewedScenarioIds:['C01','C02']};
  calendar.buggy=run('calendar-baseline',calendar.suiteDigest,calendar.reviewedScenarioIds,2); calendar.fixed=run('calendar-fixed',calendar.suiteDigest,calendar.reviewedScenarioIds,0);
  for(const phase of ['buggy','fixed']) calendar[phase].sqlEvidence=calendar.reviewedScenarioIds.map(scenarioId=>({scenarioId,runId:calendar[phase].runId,branchId:`branch-${phase}`,beforeStateDigest:'b'.repeat(64),afterStateDigest:'c'.repeat(64),assertions:[{checkId:`${scenarioId}.state`,status:phase==='buggy'?'fail':'pass'}]}));
  const text = {suiteDigest:TEXT_DIGEST,scenarioIds:ids,baseline:run('text-baseline',TEXT_DIGEST,ids,2),trial:run('text-trial',TEXT_DIGEST,ids,0)};
  const binding = {targetId:'actual-target',patchDigest:'f'.repeat(64),suiteDigest:TEXT_DIGEST,baselineRunId:'text-baseline',trialRunId:'text-trial',dispatchedPayloadDigest:'d'.repeat(64),appliedPayloadDigest:'d'.repeat(64)};
  const appliedReceipts=ids.map((scenarioId,i)=>({...binding,targetVersion:'fixed',scenarioId,receiptId:`r${i}`,operationId:`op${i}`}));
  const operationIds=appliedReceipts.map(r=>r.operationId);
  const report=(suiteDigest,baselineRunId,trialRunId)=>({suiteDigest,baselineRunId,trialRunId,beforeDigest:'a'.repeat(64),afterDigest:'a'.repeat(64),private:true});
  return {evidenceSchema:EVIDENCE_SCHEMA,source:'actual_app_provider',fallback:false,
    provenance:{calendar:{kind:'controlled_fixture',authority:'operator_declared',remoteAttestation:false,hostedOrigin:'https://offline-contract.invalid',deploymentRevision:'b'.repeat(40),patchSha256:'c'.repeat(64)},text:{kind:'external_target',authority:'operator_declared',remoteAttestation:false}},calendar,text,
    remediation:{...binding,receiptId:'receipt',operationId:'op0',targetVersionBefore:'buggy',targetVersionAfter:'fixed',beforeFailed:2,afterFailed:0,afterPassed:12,regressions:0,unresolved:0,appliedReceipts},
    accounting:{operationIds,costRows:operationIds.map(operationId=>({operationId,costMicroUsd:null,measured:false})),unknownCostExplicit:true,duplicateDispatches:0,duplicateCostRowsAfterRestart:0},
    restart:{processBefore:'worker1',processAfter:'worker2',replayedDispatches:0,persistedReceiptId:'receipt',reportDigests:{calendar:'a'.repeat(64),text:'a'.repeat(64)}},
    reports:{calendar:report(calendar.suiteDigest,'calendar-baseline','calendar-fixed'),text:{...report(TEXT_DIGEST,'text-baseline','text-trial'),receiptId:'receipt'}},
    privateChat:{ownerRead:true,ownerHistoryPersisted:true,revokedOwnerStatus:404,otherCustomerStatus:404,anonymousStatus:401,reportTokenStatus:401,sharedArtifactContainsChat:false}};
};
test('offline synthetic v2 validates contract only',()=>assert.equal(validateEvidence(fixture()),true));
for(const [name,mutate] of [
  ['SQL assertions missing',e=>delete e.calendar.buggy.sqlEvidence],['SQL assertion disagrees',e=>e.calendar.fixed.sqlEvidence[0].assertions[0].status='fail'],['receipt target differs',e=>e.remediation.appliedReceipts[0].targetId='other'],['receipt patch differs',e=>e.remediation.appliedReceipts[0].patchDigest='a'.repeat(64)],['fixture hosted origin absent',e=>delete e.provenance.calendar.hostedOrigin],
  ['old schema', e=>delete e.evidenceSchema], ['Calendar-bound Text receipt',e=>e.remediation.baselineRunId=e.calendar.buggy.runId],
  ['partial Text',e=>e.text.scenarioIds.pop()],['unreviewed Calendar',e=>e.calendar.reviewedScenarioIds=[]],
  ['changed Calendar suite',e=>e.calendar.fixed.suiteDigest='e'.repeat(64)],['Calendar inconclusive',e=>e.calendar.fixed.inconclusive=1],
  ['Text inconclusive',e=>e.text.trial.inconclusive=1],['Text unresolved',e=>e.remediation.unresolved=1],['Text regression',e=>e.remediation.regressions=1],
  ['missing applied scenario',e=>e.remediation.appliedReceipts.pop()],['receipt payload mismatch',e=>e.remediation.appliedReceipts[0].appliedPayloadDigest='e'.repeat(64)],
  ['aggregate payload mismatch',e=>e.remediation.appliedPayloadDigest='e'.repeat(64)],['duplicate receipt',e=>e.remediation.appliedReceipts[1].receiptId='r0'],
  ['fixture source',e=>e.source='offline_fixture'],['lite fallback',e=>e.fallback=true],['claimed remote attestation',e=>e.provenance.text.remoteAttestation=true],
  ['missing fixture revision',e=>delete e.provenance.calendar.deploymentRevision],['same worker',e=>e.restart.processAfter='worker1'],
  ['lost receipt',e=>e.restart.persistedReceiptId='other'],['Calendar report changed',e=>e.reports.calendar.afterDigest='e'.repeat(64)],
  ['Text report changed',e=>e.reports.text.afterDigest='e'.repeat(64)],['public Calendar report',e=>e.reports.calendar.private=false],
  ['report restart mismatch',e=>e.restart.reportDigests.text='e'.repeat(64)],['duplicate cost',e=>e.accounting.costRows.push(e.accounting.costRows[0])],
  ['unknown cost marked measured',e=>e.accounting.costRows[0].measured=true],['known cost unmeasured',e=>e.accounting.costRows[0].costMicroUsd=0],
  ['duplicate dispatch',e=>e.accounting.duplicateDispatches=1],['duplicate restart costs',e=>e.accounting.duplicateCostRowsAfterRestart=1],
  ['revoked owner',e=>e.privateChat.revokedOwnerStatus=200],['other customer',e=>e.privateChat.otherCustomerStatus=200],
  ['anonymous',e=>e.privateChat.anonymousStatus=200],['report token',e=>e.privateChat.reportTokenStatus=200],['chat leak',e=>e.privateChat.sharedArtifactContainsChat=true],
]) test(`refuses ${name}`,()=>{const e=fixture();mutate(e);assert.throws(()=>validateEvidence(e));});
for(const path of ['calendar.buggy.passed','calendar.fixed.passed','text.baseline.productFailures','text.trial.passed','remediation.beforeFailed','remediation.afterFailed','remediation.afterPassed','remediation.regressions','remediation.unresolved','accounting.duplicateDispatches','accounting.duplicateCostRowsAfterRestart','restart.replayedDispatches']) {
  for(const bad of [undefined,NaN,Infinity,-Infinity,0.5,Number.MAX_SAFE_INTEGER+1,-1]) test(`refuses unsafe count ${path} ${String(bad)}`,()=>{const e=fixture(); const parts=path.split('.');let parent=e;for(const part of parts.slice(0,-1))parent=parent[part];parent[parts.at(-1)]=bad;assert.throws(()=>validateEvidence(e));});
}
for(const bad of [NaN,Infinity,-1,0.1,Number.MAX_SAFE_INTEGER+1]) test(`refuses unsafe cost ${bad}`,()=>{const e=fixture();e.accounting.costRows[0]={operationId:'op0',costMicroUsd:bad,measured:true};assert.throws(()=>validateEvidence(e));});
test('known zero differs from unknown and is accepted only measured',()=>{const e=fixture();e.accounting.costRows[0]={operationId:'op0',costMicroUsd:0,measured:true};assert.equal(validateEvidence(e),true);});
test('full12 operation plan includes reproduction and paid sessions without enlarging approved caps',async()=>{const p=await operationPlan();assert.deepEqual(p.caps,CAPS);assert.deepEqual(p.proposedMinimumCaps,{target:32,gateway:48,naive:0,cloudMutation:0});assert.deepEqual(p.proposedCurrentCompositionCaps,{target:77,gateway:50,naive:10,cloudMutation:0});assert.deepEqual(p.blockers,['calendar_subset_api_missing','same_frozen_calendar_version_binding_missing','reserved_gateway_judge_missing']);assert.equal(p.fitsApprovedCaps,false);assert.equal(p.elapsedFitEstablished,false);});
test('cannot run without explicit live flag',async()=>assert.rejects(main(['--config','/never-read']),/explicit_live/));
test('operation-plan fails before adapter import/runtime secret read/evidence journal',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'app-contract-'));try {
    const config=join(dir,'config.json'); const journal=join(dir,'evidence.jsonl');
    await writeFile(config,JSON.stringify({runId:'offline_preflight',adapterModule:'/must-not-import.mjs',privateRuntimeRef:{file:'/must-not-read'},evidenceFile:journal,approvedCaps:CAPS}),{mode:0o600});
    await assert.rejects(main(['--live','--config',config]),/operation_plan_exceeds_approved_gateway_cap/);
    await assert.rejects(access(journal));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('original preflight and metered extension agree on conditional dispatch counts',async()=>{
  const {PLAN,APPROVED}=await import('../../../../docs/track-b-metered-acceptance/plan.mjs');
  const plan=await operationPlan();
  for(const kind of Object.keys(CAPS)) {
    assert.equal(plan.proposedCurrentCompositionCaps[kind],PLAN[kind]);
    assert.equal(CAPS[kind],APPROVED[kind]);
  }
});
