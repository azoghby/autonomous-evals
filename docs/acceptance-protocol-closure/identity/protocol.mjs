import { createHash } from 'node:crypto';
export const CALENDAR_IDS = Object.freeze(['booking','conflict','duplicate','cancel','reschedule','time-zone','read-only-permission','dependency-failure','cancel-idempotence','list','adjacent','invalid-interval']);
export const CALENDAR_CANONICAL_DIGEST = 'e65d4c55cf3dd482358d4696fd946e368e4b63c454d31b3c5f4bb5058fa87663';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(x => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  return `{${Object.entries(v).filter(([,x]) => x !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
}
export const objectDigest = v => sha256(canonicalJson(v));
const ok = (v, code) => { if (!v) throw Error(code); };
const id = v => typeof v === 'string' && v.length > 0;
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const same = (a,b) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && a.every(x => b.includes(x));
export function assertCalendarVersionBinding(calendar) {
  const v = calendar?.versionBinding;
  ok(v?.kind === 'independent_job_suites' && v.canonicalScenarioDigest === CALENDAR_CANONICAL_DIGEST, 'calendar_canonical_identity_required');
  ok(same(calendar.reviewedScenarioIds,CALENDAR_IDS), 'full_calendar12_required');
  ok(id(v.baseline?.jobId) && id(v.trial?.jobId) && v.baseline.jobId !== v.trial.jobId && digest(v.baseline.suiteDigest) && digest(v.trial.suiteDigest), 'actual_calendar_jobs_required');
  ok(calendar.suiteDigest === v.baseline.suiteDigest, 'calendar_baseline_digest_required');
  for (const [phase,binding] of [['buggy',v.baseline],['fixed',v.trial]]) {
    const run = calendar[phase];
    ok(run?.jobId === binding.jobId && run.suiteDigest === binding.suiteDigest && id(run.runId) && same(run.scenarioIds,CALENDAR_IDS), 'calendar_run_binding_required');
    ok(Array.isArray(run.sqlEvidence) && same(run.sqlEvidence.map(x=>x.scenarioId),CALENDAR_IDS), 'full_calendar_sql_required');
    ok(run.sqlEvidence.every(row => row.jobId === binding.jobId && row.suiteDigest === binding.suiteDigest && row.runId === run.runId && id(row.branchId)), 'calendar_sql_identity_required');
  }
  ok(calendar.buggy.runId !== calendar.fixed.runId, 'calendar_distinct_runs_required');
  return true;
}
export function assertPromptApplication(receipt) {
  const p = receipt?.promptApplication;
  ok(p?.kind === 'approved_prompt_application' && p.authority === 'independently_approved' && p.remoteAttestation === false, 'prompt_application_authority_required');
  ok(id(p.approvalId) && id(p.approvedBy) && id(p.proposalTaskId) && id(p.proposalSessionId), 'prompt_approval_identity_required');
  ok(digest(p.baselinePromptSha256) && digest(p.appliedPromptSha256) && p.baselinePromptSha256 !== p.appliedPromptSha256 && p.approvedPromptSha256 === p.appliedPromptSha256, 'approved_applied_prompt_required');
  ok(id(p.endpoint) && p.endpoint === p.endpointBefore && id(p.model) && p.model === p.modelBefore && receipt.targetVersionBefore === receipt.targetVersionAfter, 'same_endpoint_model_version_required');
  ok(Array.isArray(receipt.appliedReceipts) && receipt.appliedReceipts.length === 12 && receipt.appliedReceipts.every(r => r.appliedPromptSha256 === p.appliedPromptSha256), 'all12_applied_prompt_hashes_required');
  return true;
}
/** Trust boundary: call only inside the server transport observer, using the actual immutable payload.
 * reserve must atomically persist unique operationId and input digest before dispatch across workers.
 * Caller-supplied receipt hashes cannot produce an accepted receipt without recorded bytes + observation.
 * This proves local payload application, never remote inference or remote prompt installation.
 */
export function createReceiptBridge({ binding, jobId, endpoint, baselineSystemPrompt, approval, reserve }) {
  ok(id(jobId) && id(binding?.targetId) && id(binding.targetVersion) && ['test','live'].includes(binding.environment), 'trusted_binding_required');
  ok(typeof reserve === 'function' && id(endpoint?.url) && id(endpoint.model), 'durable_reservation_required');
  ok(digest(approval?.approvedPromptSha256) && approval.approvedPromptSha256 !== sha256(baselineSystemPrompt) && ['approvalId','approvedBy','proposalTaskId','proposalSessionId'].every(k=>id(approval[k])), 'independent_approval_required');
  // Copy trusted policy so later mutation cannot change receipt authority.
  binding=structuredClone(binding); endpoint=structuredClone(endpoint); approval=structuredClone(approval);
  const dispatches=new Map(), used=new Set(), observations=new Map();
  return Object.freeze({
    async beforeDispatch(evidence, payload) {
      evidence=structuredClone(evidence); payload=structuredClone(payload);
      ok(evidence.jobId === jobId && ['targetId','targetVersion','environment'].every(k=>evidence[k] === binding[k]), 'dispatch_binding_mismatch');
      ok(id(evidence.operationId) && !used.has(evidence.operationId) && id(evidence.scenarioId) && id(evidence.runId) && digest(evidence.suiteDigest), 'dispatch_identity_or_replay');
      ok(payload.model === endpoint.model && payload.messages?.length === 2 && payload.messages[0].role === 'system' && payload.messages[1].role === 'user' && sha256(payload.messages[0].content) === approval.approvedPromptSha256 && evidence.payloadDigest === objectDigest(payload), 'actual_payload_mismatch');
      used.add(evidence.operationId);
      await reserve(evidence.operationId,objectDigest({evidence,payload}));
      dispatches.set(evidence.operationId,{evidence,payload});
    },
    observed(evidence, usage) {
      const d=dispatches.get(evidence.operationId);
      ok(d && canonicalJson(d.evidence) === canonicalJson(evidence) && !observations.has(evidence.operationId), 'observation_identity_or_replay');
      ok(usage === null || (['promptTokens','completionTokens','totalTokens'].every(k=>Number.isSafeInteger(usage[k]) && usage[k]>=0) && usage.totalTokens === usage.promptTokens+usage.completionTokens), 'usage_invalid');
      observations.set(evidence.operationId,structuredClone(usage));
    },
    accept(coreReceipt, operationId) {
      const d=dispatches.get(operationId); ok(d && observations.has(operationId), 'observed_dispatch_required');
      const e=d.evidence;
      ok(['targetId','targetVersion','environment','trialId','baselineRunId','suiteDigest','scenarioId','patchDigest'].every(k=>coreReceipt[k] === e[k]) && coreReceipt.runId === e.runId && coreReceipt.isolated === true && coreReceipt.actualSystemPrompt === d.payload.messages[0].content, 'core_receipt_mismatch');
      return Object.freeze({scenarioId:e.scenarioId,receiptId:`applied:${objectDigest({operationId,payloadDigest:e.payloadDigest})}`,operationId,targetId:e.targetId,targetVersion:e.targetVersion,patchDigest:e.patchDigest,suiteDigest:e.suiteDigest,baselineRunId:e.baselineRunId,trialRunId:e.runId,dispatchedPayloadDigest:e.payloadDigest,appliedPayloadDigest:e.payloadDigest,appliedPromptSha256:sha256(coreReceipt.actualSystemPrompt)});
    },
    promptApplication() { return Object.freeze({kind:'approved_prompt_application',authority:'independently_approved',remoteAttestation:false,...approval,baselinePromptSha256:sha256(baselineSystemPrompt),appliedPromptSha256:approval.approvedPromptSha256,endpoint:endpoint.url,endpointBefore:endpoint.url,model:endpoint.model,modelBefore:endpoint.model}); }
  });
}
