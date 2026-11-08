/** Adapter to the shared SQL-capable ledger; no provider-side monetary cap is implied. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../evals/text/freeze';
import type { BudgetLedger } from '../evals/types';
import type { NaiveProxyBudgetPort } from './naive-proxy';
import { NaiveProxyJudgeUnavailableError } from './naive-proxy';
export function createNaiveProxyBudget(ledger: BudgetLedger, options: { jobId: string; period: string; jobCapMicroUsd: number; judgeCapMicroUsd: number }): NaiveProxyBudgetPort {
  const config = { ...options };
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(config.jobId) || !/^[A-Za-z0-9_-]{1,80}$/.test(config.period) || [config.jobCapMicroUsd, config.judgeCapMicroUsd].some(n => !Number.isSafeInteger(n) || n <= 0)) throw new NaiveProxyJudgeUnavailableError();
  const expected = (operationId: string) => `naive-proxy:${createHash('sha256').update(canonicalJson({jobId:config.jobId,operationId})).digest('hex')}`;
  return {
    async reserve(input) {
      if (input.jobId !== config.jobId || !/^[A-Za-z0-9_.:-]{1,200}$/.test(input.operationId) || input.reservationId !== expected(input.operationId) || !/^[a-f0-9]{64}$/.test(input.inputDigest) || !Number.isSafeInteger(input.amountMicroUsd) || input.amountMicroUsd <= 0) throw new NaiveProxyJudgeUnavailableError();
      const result = await ledger.reserve({ reservationId: input.reservationId, jobId: input.jobId, amountMicroUsd: input.amountMicroUsd, scopes: [
        { key: `job:${config.jobId}`, capMicroUsd: config.jobCapMicroUsd },
        { key: `agent:judge:${config.period}`, capMicroUsd: config.judgeCapMicroUsd },
      ] });
      return result.ok;
    },
    async settle({ reservationId, receipt }) {
      if (receipt.jobId !== config.jobId || !/^[A-Za-z0-9_.:-]{1,200}$/.test(receipt.operationId) || reservationId !== expected(receipt.operationId) || !/^req_[0-9a-hjkmnp-tv-z]{26}$/.test(receipt.requestId) || receipt.idempotencyKey !== `naive_proxy:${receipt.requestId}` || receipt.source !== 'naive_proxy' || receipt.measured !== true || !Number.isSafeInteger(receipt.microUsd) || receipt.microUsd < 0) throw new NaiveProxyJudgeUnavailableError();
      const settled = await ledger.settle(reservationId, receipt.microUsd);
      if (settled.settledMicroUsd !== receipt.microUsd) throw new NaiveProxyJudgeUnavailableError();
    },
  };
}
