#!/usr/bin/env node
import { readFile, stat, open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
export const CAPS = Object.freeze({ target: 32, gateway: 16, naive: 0, cloudMutation: 0 });
const requireTrue = (value, code) => { if (!value) throw Error(code); };
export const EVIDENCE_SCHEMA = 'app_acceptance/v2';
export const TEXT_DIGEST = '0e5d6df16cd4c5953bb3a0966cf410216690549d3393cf60150d30b711a942e9';
const TEXT_IDS = Array.from({ length: 12 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
const id = value => typeof value === 'string' && value.length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const uniqueIds = values => Array.isArray(values) && values.length > 0 && values.every(id) && new Set(values).size === values.length;
const sameSet = (a, b) => uniqueIds(a) && uniqueIds(b) && a.length === b.length && a.every(x => b.includes(x));
function provenance(value) {
  requireTrue(value?.authority === 'operator_declared' && value.remoteAttestation === false && ['controlled_fixture', 'external_target'].includes(value.kind), 'operator_provenance_required');
  if (value.kind === 'controlled_fixture') {
    requireTrue(/^[a-f0-9]{40}$/.test(value.deploymentRevision ?? '') && digest(value.patchSha256), 'controlled_fixture_revision_required');
    let origin; try { origin = new URL(value.hostedOrigin); } catch { throw Error('controlled_fixture_hosted_origin_required'); }
    requireTrue(origin.protocol === 'https:' && !origin.username && !origin.password && origin.origin === value.hostedOrigin, 'controlled_fixture_hosted_origin_required');
  }
}
function run(value, suiteDigest, scenarioIds) {
  requireTrue(id(value?.runId) && value.suiteDigest === suiteDigest && sameSet(value.scenarioIds, scenarioIds), 'frozen_run_identity_required');
  requireTrue(['passed', 'productFailures', 'inconclusive'].every(key => integer(value[key])) && value.passed + value.productFailures + value.inconclusive === scenarioIds.length, 'safe_complete_run_counts_required');
}
export function validateEvidence(e) {
  requireTrue(e?.evidenceSchema === EVIDENCE_SCHEMA, 'versioned_evidence_required');
  requireTrue(e.source === 'actual_app_provider' && e.fallback === false, 'real_app_evidence_required');
  provenance(e.provenance?.calendar); provenance(e.provenance?.text);
  const calendar = e.calendar, text = e.text;
  requireTrue(digest(calendar?.suiteDigest) && uniqueIds(calendar.reviewedScenarioIds) && calendar.reviewedScenarioIds.length >= 2, 'reviewed_calendar_suite_required');
  run(calendar.buggy, calendar.suiteDigest, calendar.reviewedScenarioIds); run(calendar.fixed, calendar.suiteDigest, calendar.reviewedScenarioIds);
  for (const phase of ['buggy', 'fixed']) {
    const evidence = calendar[phase].sqlEvidence;
    requireTrue(Array.isArray(evidence) && sameSet(evidence.map(row => row.scenarioId), calendar.reviewedScenarioIds) && evidence.every(row => row.runId === calendar[phase].runId && id(row.branchId) && digest(row.beforeStateDigest) && digest(row.afterStateDigest) && Array.isArray(row.assertions) && uniqueIds(row.assertions.map(a => a.checkId)) && row.assertions.every(a => ['pass', 'fail'].includes(a.status))), 'calendar_sql_assertions_required');
    requireTrue(evidence.filter(row => row.assertions.some(a => a.status === 'fail')).length === calendar[phase].productFailures && evidence.filter(row => row.assertions.every(a => a.status === 'pass')).length === calendar[phase].passed, 'calendar_sql_verdict_binding_required');
  }
  requireTrue(calendar.buggy.runId !== calendar.fixed.runId && calendar.buggy.productFailures > 0 && calendar.buggy.inconclusive === 0 && calendar.fixed.productFailures === 0 && calendar.fixed.inconclusive === 0 && calendar.fixed.passed === calendar.reviewedScenarioIds.length, 'calendar_buggy_fixed_expectation');
  requireTrue(text?.suiteDigest === TEXT_DIGEST && sameSet(text.scenarioIds, TEXT_IDS), 'full_frozen_text12_required');
  run(text.baseline, text.suiteDigest, text.scenarioIds); run(text.trial, text.suiteDigest, text.scenarioIds);
  requireTrue(text.baseline.runId !== text.trial.runId && text.baseline.productFailures > 0 && text.baseline.inconclusive === 0 && text.trial.productFailures === 0 && text.trial.inconclusive === 0 && text.trial.passed === 12, 'text12_baseline_trial_expectation');
  const receipt = e.remediation;
  requireTrue(id(receipt?.receiptId) && id(receipt.targetId) && digest(receipt.patchDigest) && id(receipt.operationId) && id(receipt.targetVersionBefore) && id(receipt.targetVersionAfter) && receipt.targetVersionBefore !== receipt.targetVersionAfter && receipt.suiteDigest === text.suiteDigest && receipt.baselineRunId === text.baseline.runId && receipt.trialRunId === text.trial.runId, 'text_remediation_receipt_identity_required');
  requireTrue(['beforeFailed', 'afterFailed', 'afterPassed', 'regressions', 'unresolved'].every(key => integer(receipt[key])) && receipt.beforeFailed === text.baseline.productFailures && receipt.afterFailed === 0 && receipt.afterPassed === 12 && receipt.regressions === 0 && receipt.unresolved === 0 && digest(receipt.dispatchedPayloadDigest) && receipt.appliedPayloadDigest === receipt.dispatchedPayloadDigest, 'remediation_receipt_required');
  requireTrue(Array.isArray(receipt.appliedReceipts) && sameSet(receipt.appliedReceipts.map(r => r.scenarioId), TEXT_IDS) && uniqueIds(receipt.appliedReceipts.map(r => r.receiptId)) && uniqueIds(receipt.appliedReceipts.map(r => r.operationId)) && receipt.appliedReceipts.every(r => r.targetId === receipt.targetId && r.targetVersion === receipt.targetVersionAfter && r.patchDigest === receipt.patchDigest && r.baselineRunId === receipt.baselineRunId && r.trialRunId === receipt.trialRunId && r.suiteDigest === receipt.suiteDigest && digest(r.dispatchedPayloadDigest) && r.appliedPayloadDigest === r.dispatchedPayloadDigest), 'all12_applied_receipts_required');
  const accounting = e.accounting;
  requireTrue(uniqueIds(accounting?.operationIds) && accounting.operationIds.includes(receipt.operationId) && receipt.appliedReceipts.every(r => accounting.operationIds.includes(r.operationId)) && accounting.unknownCostExplicit === true && accounting.duplicateDispatches === 0 && accounting.duplicateCostRowsAfterRestart === 0 && Array.isArray(accounting.costRows) && sameSet(accounting.costRows.map(r => r.operationId), accounting.operationIds) && accounting.costRows.every(row => row.costMicroUsd === null ? row.measured === false : integer(row.costMicroUsd) && row.measured === true), 'accounting_required');
  requireTrue(id(e.restart?.processBefore) && id(e.restart.processAfter) && e.restart.processBefore !== e.restart.processAfter && e.restart.replayedDispatches === 0 && e.restart.persistedReceiptId === receipt.receiptId, 'actual_process_restart_required');
  for (const [name, suiteDigest, baselineRunId, trialRunId] of [['calendar', calendar.suiteDigest, calendar.buggy.runId, calendar.fixed.runId], ['text', text.suiteDigest, text.baseline.runId, text.trial.runId]]) {
    const report = e.reports?.[name];
    requireTrue(digest(report?.beforeDigest) && report.afterDigest === report.beforeDigest && e.restart.reportDigests?.[name] === report.beforeDigest && report.suiteDigest === suiteDigest && report.baselineRunId === baselineRunId && report.trialRunId === trialRunId && report.private === true && (name !== 'text' || report.receiptId === receipt.receiptId), 'persisted_private_reports_required');
  }
  requireTrue(e.privateChat?.ownerRead === true && e.privateChat.ownerHistoryPersisted === true && e.privateChat.revokedOwnerStatus === 404 && e.privateChat.otherCustomerStatus === 404 && e.privateChat.anonymousStatus === 401 && e.privateChat.reportTokenStatus === 401 && e.privateChat.sharedArtifactContainsChat === false, 'private_chat_authorization_required');
  return true;
}
// Count every rubric call from the admitted suite, without importing a runtime or reading credentials.
export async function operationPlan() {
  const artifact = JSON.parse(await readFile(new URL('../../../../packages/core/src/evals/text/__tests__/evidence/text-design-v3-2026-11-07.json', import.meta.url), 'utf8'));
  const suite = artifact.outcome.suite;
  requireTrue(suite.digest === TEXT_DIGEST && sameSet(suite.scenarios.map(s => s.id), TEXT_IDS), 'accepted_text_suite_changed');
  requireTrue(suite.scenarios.every(s => Array.isArray(s.rubricChecks)), 'accepted_rubric_checks_required');
  const proposed = { target: 32, gateway: suite.scenarios.reduce((sum, s) => sum + s.rubricChecks.length, 0) * 2, naive: 0, cloudMutation: 0 };
  // One confirmed Text failure requires re-judging that scenario; five paid
  // sessions (investigation, proposal, three reports) each need create + get.
  // This is a conditional immediate-completion path, not an allowance for retries.
  const reproductionRubrics = Math.max(...suite.scenarios.map(s => s.rubricChecks.length));
  const currentComposition = { ...proposed, target: 77, gateway: proposed.gateway + reproductionRubrics, naive: 10 };
  return { schema: 'app_operation_plan/v2', evidenceSchema: EVIDENCE_SCHEMA, caps: CAPS, proposedMinimumCaps: proposed, proposedCurrentCompositionCaps: currentComposition, calendarScenarios: 2, calendarTargetTurnsPerScenario: 2, textScenarios: 12, targetCompletionTokenCap: 512, gatewayCompletionTokenCap: 2048, maxElapsedMs: 180000, fitsApprovedCaps: Object.keys(CAPS).every(k => integer(currentComposition[k]) && currentComposition[k] <= CAPS[k]), elapsedFitEstablished: false, blockers: ['calendar_subset_api_missing', 'same_frozen_calendar_version_binding_missing', 'reserved_gateway_judge_missing'], liveRunPerformed: false, failure: 'operation_plan_exceeds_approved_gateway_cap', qualifications: 'Desired two-scenario minimum32 excludes reproductions. Current factories run all12 Calendar scenarios/version:48 target turns plus4 reproduction turns; Text baseline/trial plus confirmed reproduction25 =>77 target. Calendar subset API, same frozen-suite version transition binding and reserved rubric judge are missing. Gateway50 includes two reproduction judgments; Naive10 includes create/get for investigation, proposal and three reports. Polling/recovery or missing genuine design requires additional explicitly reviewed operations. This conditional plan is not a monetary authorization. No elapsed bound has been demonstrated.' };
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--plan') {
    console.log(JSON.stringify(await operationPlan(), null, 2)); return;
  }
  requireTrue(argv.length === 3 && argv[0] === '--live' && argv[1] === '--config', 'explicit_live_flag_required');
  const plan = await operationPlan();
  requireTrue(plan.fitsApprovedCaps, 'operation_plan_exceeds_approved_gateway_cap');
  const metadata = await stat(argv[2]);
  requireTrue(metadata.isFile() && metadata.size <= 16384 && (metadata.mode & 0o077) === 0, 'private_config_required');
  const config = JSON.parse(await readFile(argv[2], 'utf8'));
  requireTrue(/^[A-Za-z0-9_-]{1,48}$/.test(config.runId) && typeof config.adapterModule === 'string' && typeof config.privateRuntimeRef === 'object' && typeof config.evidenceFile === 'string', 'invalid_configuration');
  requireTrue(JSON.stringify(config.approvedCaps) === JSON.stringify(CAPS), 'exact_approved_caps_required');
  const journal = await open(config.evidenceFile, 'wx', 0o600);
  const record = async entry => { await journal.write(JSON.stringify(entry) + '\n'); await journal.sync(); };
  const counts = Object.fromEntries(Object.keys(CAPS).map(k => [k, 0]));
  const seen = new Set();
  const abort = AbortSignal.timeout(180000);
  try {
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('app_acceptance_deadline')), 180000); });
    let evidence;
    try { evidence = await Promise.race([(async () => {
    const module = await import(pathToFileURL(resolve(config.adapterModule)));
    requireTrue(typeof module.createAcceptanceDriver === 'function', 'app_adapter_export_missing');
    const driver = await module.createAcceptanceDriver({ runId: config.runId, privateRuntimeRef: config.privateRuntimeRef, signal: abort,
      limits: { ...CAPS, targetCompletionTokens: 512, gatewayCompletionTokens: 2048 },
      beforeDispatch: async ({ kind, operationId }) => {
        requireTrue(!abort.aborted && Object.hasOwn(CAPS, kind) && typeof operationId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(operationId) && !seen.has(operationId) && counts[kind] < CAPS[kind], 'dispatch_denied');
        seen.add(operationId); counts[kind]++; await record({ kind: 'dispatch_intent', source: kind, operationId });
      },
    });
    requireTrue(driver?.source === 'actual_app_provider' && driver.fallback === false, 'app_adapter_real_path_required');
    return driver.run();
    })(), deadline]); } finally { clearTimeout(timer); }
    validateEvidence(evidence);
    requireTrue(counts.target > 0 && counts.gateway > 0 && counts.naive === 0 && counts.cloudMutation === 0 && evidence.accounting.operationIds.length === seen.size && evidence.accounting.operationIds.every(id => seen.has(id)), 'actual_metered_dispatch_required');
    // Hash the detailed app-owned evidence; never log private report/chat contents or runtime refs.
    await record({ kind: 'accepted', scope: 'actual_app_provider', counts, evidenceDigest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') });
    console.log(JSON.stringify({ accepted: true, scope: 'actual_app_provider', counts }));
  } catch { await record({ kind: 'failed_or_ambiguous', counts, retry: 'operator_reconciliation_required' }); throw Error('app_live_acceptance_failed'); }
  finally { await journal.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('App acceptance failed. Inspect the private journal and adapter; no automatic retry.'); process.exitCode = 1; });
