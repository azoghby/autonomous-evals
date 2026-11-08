import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptBridge, objectDigest, sha256, assertPromptApplication, assertCalendarVersionBinding, CALENDAR_IDS, CALENDAR_CANONICAL_DIGEST } from '../../../docs/acceptance-protocol-closure/identity/protocol.mjs';
const prompt='Independent offline reviewed replacement';
const binding={targetId:'controlled-text',targetVersion:'track-b-lumen-remediation-v1',environment:'test'};
const approval={approvedPromptSha256:sha256(prompt),approvalId:'fixture-review',approvedBy:'offline-test-only',proposalTaskId:'fixture-task',proposalSessionId:'fixture-session'};
const payload={model:'track-b-lumen-remediation-v1',messages:[{role:'system',content:prompt},{role:'user',content:'frozen user'}],max_completion_tokens:512,store:false};
function fixture(reservations=new Map()) {
 const bridge=createReceiptBridge({binding,jobId:'job',endpoint:{url:'https://fixture.invalid/api/internal/track-b-remediation/chat/completions',model:payload.model},baselineSystemPrompt:'baseline',approval,reserve:async(id,digest)=>{assert(!reservations.has(id),'already_reserved');reservations.set(id,digest);}});
 const evidence={jobId:'job',...binding,trialId:'trial',baselineRunId:'baseline',suiteDigest:'a'.repeat(64),runId:'trial-run',scenarioId:'S01',patchDigest:'b'.repeat(64),payloadDigest:objectDigest(payload),operationId:'operation'};
 const coreReceipt={...binding,isolated:true,trialId:evidence.trialId,baselineRunId:evidence.baselineRunId,suiteDigest:evidence.suiteDigest,runId:evidence.runId,scenarioId:evidence.scenarioId,patchDigest:evidence.patchDigest,actualSystemPrompt:prompt};
 return {bridge,evidence,coreReceipt};
}
test('receipt derives from observed actual bytes; unknown remains unknown and version stays real',async()=>{
 const {bridge,evidence,coreReceipt}=fixture(); await bridge.beforeDispatch(evidence,payload); bridge.observed(evidence,null); const r=bridge.accept(coreReceipt,evidence.operationId);
 assert.equal(r.targetVersion,binding.targetVersion); assert.equal(r.appliedPromptSha256,sha256(prompt));
 const receipt={targetVersionBefore:binding.targetVersion,targetVersionAfter:binding.targetVersion,promptApplication:bridge.promptApplication(),appliedReceipts:Array.from({length:12},()=>r)};
 assert.equal(assertPromptApplication(receipt),true);
 for(const key of ['approvedPromptSha256','baselinePromptSha256']) { const bad=structuredClone(receipt); bad.promptApplication[key]=key === 'baselinePromptSha256' ? bad.promptApplication.appliedPromptSha256 : 'c'.repeat(64);assert.throws(()=>assertPromptApplication(bad)); }
});
test('forged receipt, unobserved dispatch, changed versions, prompt and replay fail',async()=>{
 const {bridge,evidence,coreReceipt}=fixture(); assert.throws(()=>bridge.accept(coreReceipt,'operation'));
 await assert.rejects(bridge.beforeDispatch({...evidence,targetVersion:'invented'},payload));
 await assert.rejects(bridge.beforeDispatch(evidence,{...payload,messages:[{role:'system',content:'unapproved'},{role:'user',content:'frozen user'}]}));
 await bridge.beforeDispatch(evidence,payload); assert.throws(()=>bridge.accept(coreReceipt,'operation'));
 bridge.observed(evidence,null); assert.throws(()=>bridge.accept({...coreReceipt,targetVersion:'invented'},'operation')); assert.throws(()=>bridge.accept({...coreReceipt,actualSystemPrompt:'forged'},'operation'));assert.throws(()=>bridge.observed(evidence,null));await assert.rejects(bridge.beforeDispatch(evidence,payload));
});
test('durable reservation fences separate bridge instances before a second dispatch',async()=>{
 const reservations=new Map(), a=fixture(reservations), b=fixture(reservations);await a.bridge.beforeDispatch(a.evidence,payload); await assert.rejects(b.bridge.beforeDispatch(b.evidence,payload),/already_reserved/);assert.equal(reservations.size,1);
});
function calendar() {
 const c={suiteDigest:'a'.repeat(64),reviewedScenarioIds:[...CALENDAR_IDS],versionBinding:{kind:'independent_job_suites',canonicalScenarioDigest:CALENDAR_CANONICAL_DIGEST,baseline:{jobId:'calendar-before',suiteDigest:'a'.repeat(64)},trial:{jobId:'calendar-after',suiteDigest:'b'.repeat(64)}}};
 for(const [phase,b] of [['buggy',c.versionBinding.baseline],['fixed',c.versionBinding.trial]]) c[phase]={...b,runId:phase,scenarioIds:[...CALENDAR_IDS],sqlEvidence:CALENDAR_IDS.map(scenarioId=>({...b,runId:phase,scenarioId,branchId:phase+'-branch'}))};return c;
}
test('Calendar preserves actual independent job suite digests and full12 SQL identity',()=>{
 assert.equal(assertCalendarVersionBinding(calendar()),true);
 for(const change of [c=>c.fixed.suiteDigest=c.suiteDigest,c=>c.fixed.sqlEvidence[0].jobId='other',c=>c.reviewedScenarioIds=['booking','cancel'],c=>c.fixed.scenarioIds.pop(),c=>c.versionBinding.canonicalScenarioDigest='f'.repeat(64)]){const c=calendar();change(c);assert.throws(()=>assertCalendarVersionBinding(c));}
});
