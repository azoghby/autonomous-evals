import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvidence, main } from './app-run.mjs';
// Offline validation of the adapter contract, never actual provider evidence.
const fixture = () => ({ source: 'actual_app_provider', fallback: false,
  calendar: { suiteDigest: 'frozen', buggy: { runId: 'baseline', suiteDigest: 'frozen', productFailures: 2, inconclusive: 0 }, fixed: { runId: 'trial', suiteDigest: 'frozen', productFailures: 0, inconclusive: 0, passed: 2 } },
  remediation: { receiptId: 'receipt', operationId: 'op', dispatchedPayloadDigest: 'd'.repeat(64), suiteDigest: 'frozen', baselineRunId: 'baseline', trialRunId: 'trial', targetVersionBefore: 'buggy', targetVersionAfter: 'fixed', beforeFailed: 2, afterFailed: 0, afterPassed: 2, regressions: 0 },
  accounting: { operationIds: ['op'], duplicateCostRowsAfterRestart: 0, costRows: [{ operationId: 'op', costMicroUsd: null, measured: false }], unknownCostExplicit: true, duplicateDispatches: 0 },
  restart: { processBefore: 'first', processAfter: 'second', replayedDispatches: 0, persistedReceiptId: 'receipt' },
  report: { beforeDigest: 'a'.repeat(64), afterDigest: 'a'.repeat(64), suiteDigest: 'frozen', receiptId: 'receipt', private: true },
  privateChat: { ownerRead: true, revokedOwnerStatus: 404, ownerHistoryPersisted: true, otherCustomerStatus: 404, anonymousStatus: 401, reportTokenStatus: 401, sharedArtifactContainsChat: false },
});
test('offline fixture validates only contract, not live acceptance', () => assert.equal(validateEvidence(fixture()), true));
for (const [name, mutate] of [
  ['unbound receipt', e => e.remediation.trialRunId = 'other'], ['missing payload digest', e => delete e.remediation.dispatchedPayloadDigest], ['duplicate cost row', e => e.accounting.costRows.push(e.accounting.costRows[0])], ['revoked owner access', e => e.privateChat.revokedOwnerStatus = 200],
  ['mock fallback', e => e.fallback = true], ['fixture source', e => e.source = 'offline_fixture'],
  ['calendar inconclusive', e => e.calendar.fixed.inconclusive = 1], ['different suite', e => e.calendar.fixed.suiteDigest = 'other'],
  ['same process', e => e.restart.processAfter = 'first'], ['duplicate cost dispatch', e => e.accounting.duplicateDispatches = 1],
  ['lost receipt', e => e.restart.persistedReceiptId = 'other'], ['report changed', e => e.report.afterDigest = 'b'.repeat(64)],
  ['chat leak', e => e.privateChat.sharedArtifactContainsChat = true], ['report token chat access', e => e.privateChat.reportTokenStatus = 200],
]) test(`refuses ${name}`, () => { const e = fixture(); mutate(e); assert.throws(() => validateEvidence(e)); });
test('cannot run app adapter without explicit live flag', async () => await assert.rejects(main(['--config', '/never-read']), /explicit_live/));
