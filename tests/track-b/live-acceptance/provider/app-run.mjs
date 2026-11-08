#!/usr/bin/env node
import { readFile, stat, open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
export const CAPS = Object.freeze({ target: 32, gateway: 16, naive: 0, cloudMutation: 0 });
const requireTrue = (value, code) => { if (!value) throw Error(code); };
export function validateEvidence(e) {
  requireTrue(e?.source === 'actual_app_provider' && e.fallback === false, 'real_app_evidence_required');
  requireTrue(e.calendar?.suiteDigest && e.calendar.buggy?.suiteDigest === e.calendar.suiteDigest && e.calendar.fixed?.suiteDigest === e.calendar.suiteDigest, 'same_frozen_calendar_suite_required');
  requireTrue(e.calendar.buggy.productFailures > 0 && e.calendar.buggy.inconclusive === 0 && e.calendar.fixed.productFailures === 0 && e.calendar.fixed.inconclusive === 0 && e.calendar.fixed.passed >= 2, 'calendar_buggy_fixed_expectation');
  const receipt = e.remediation;
  requireTrue(receipt?.receiptId && receipt.operationId && receipt.targetVersionBefore !== receipt.targetVersionAfter && receipt.beforeFailed > 0 && receipt.afterFailed === 0 && receipt.afterPassed > 0 && receipt.regressions === 0 && /^[a-f0-9]{64}$/.test(receipt.dispatchedPayloadDigest ?? '') && receipt.suiteDigest === e.calendar.suiteDigest && receipt.baselineRunId === e.calendar.buggy.runId && receipt.trialRunId === e.calendar.fixed.runId && receipt.baselineRunId && receipt.trialRunId && receipt.baselineRunId !== receipt.trialRunId, 'remediation_receipt_required');
  requireTrue(e.accounting?.operationIds?.length > 0 && new Set(e.accounting.operationIds).size === e.accounting.operationIds.length && e.accounting.operationIds.includes(receipt.operationId) && e.accounting.unknownCostExplicit === true && e.accounting.duplicateDispatches === 0 && e.accounting.duplicateCostRowsAfterRestart === 0 && Array.isArray(e.accounting.costRows) && e.accounting.costRows.length === e.accounting.operationIds.length && new Set(e.accounting.costRows.map(row => row.operationId)).size === e.accounting.operationIds.length && e.accounting.costRows.every(row => e.accounting.operationIds.includes(row.operationId) && (row.costMicroUsd === null || (Number.isInteger(row.costMicroUsd) && row.costMicroUsd >= 0 && row.measured === true))), 'accounting_required');
  requireTrue(e.restart?.processBefore && e.restart.processAfter && e.restart.processBefore !== e.restart.processAfter && e.restart.replayedDispatches === 0 && e.restart.persistedReceiptId === receipt.receiptId, 'actual_process_restart_required');
  requireTrue(/^[a-f0-9]{64}$/.test(e.report?.beforeDigest ?? '') && e.report.beforeDigest === e.report.afterDigest && e.report.suiteDigest === e.calendar.suiteDigest && e.report.receiptId === receipt.receiptId && e.report.private === true, 'persisted_private_report_required');
  requireTrue(e.privateChat?.ownerRead === true && e.privateChat.ownerHistoryPersisted === true && e.privateChat.revokedOwnerStatus === 404 && e.privateChat.otherCustomerStatus === 404 && e.privateChat.anonymousStatus === 401 && e.privateChat.reportTokenStatus === 401 && e.privateChat.sharedArtifactContainsChat === false, 'private_chat_authorization_required');
  return true;
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--plan') {
    console.log(JSON.stringify({ scope: 'actual_app_provider', caps: CAPS, targetCompletionTokenCap: 512, gatewayCompletionTokenCap: 2048, naiveDesignRuns: 0, maxElapsedMs: 180000, liveRunPerformed: false, requiredConfiguration: ['adapterModule', 'runId', 'evidenceFile', 'privateRuntimeRef', 'approvedCaps'] }, null, 2)); return;
  }
  requireTrue(argv.length === 3 && argv[0] === '--live' && argv[1] === '--config', 'explicit_live_flag_required');
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
