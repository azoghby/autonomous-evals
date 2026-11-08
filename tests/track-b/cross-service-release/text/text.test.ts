import { test } from 'node:test';
import { textPendingRestartConsistency, textPendingTargetRestart } from './cases.js';
test('acceptance: text pending investigation → SQL restart → report/private progress consistency', { timeout: 60_000 }, textPendingRestartConsistency);
test('acceptance: pending target fence survives SQL restart without redispatch', { timeout: 60_000 }, textPendingTargetRestart);
