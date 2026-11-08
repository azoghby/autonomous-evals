import { z } from 'zod';
import { CostEntry } from '../contracts';
import type { ServiceContext } from '../contracts/services';
import type { RubricJudge } from '../evals/types';
import { createNaiveProxyJudge, NaiveProxyJudgeUnavailableError, type NaiveProxyJudgeDeps } from './naive-proxy';

const Receipt = z.object({
  source: z.literal('naive_proxy'), jobId: z.uuid(),
  operationId: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
  model: z.string().min(1).refine(v => v.trim() === v),
  requestId: z.string().regex(/^req_[0-9a-hjkmnp-tv-z]{26}$/),
  microUsd: z.number().refine(v => Number.isSafeInteger(v) && v >= 0),
  measured: z.literal(true), idempotencyKey: z.string(),
}).strict();
const unavailable = (): never => { throw new NaiveProxyJudgeUnavailableError(); };

/** Maps only a reconciled provider receipt; never represents proxy requests as sessions. */
export function naiveProxyCostEntry(raw: unknown, expected: { jobId: string; model: string }): Omit<z.infer<typeof CostEntry>, 'jobId'> {
  const result = Receipt.safeParse(raw);
  if (!result.success) return unavailable();
  const receipt = result.data;
  if (receipt.jobId !== expected.jobId || receipt.model !== expected.model || receipt.idempotencyKey !== `naive_proxy:${receipt.requestId}`) return unavailable();
  return {
    source: 'naive_proxy', agent: 'judge', requestId: receipt.requestId, microUsd: receipt.microUsd,
    meta: { purpose: receipt.operationId, kind: 'rubric_judge', model: receipt.model, operationId: receipt.operationId, measured: true, idempotencyKey: receipt.idempotencyKey },
  };
}

/** Installs the job's atomic keyed cost sink. Durable checkpoints, current authorization and
 * aggregate budget reservation/settlement remain mandatory owner-supplied ports.
 * A zero current context budget blocks invocation, including completed judge replay;
 * separately retained measured receipts can still be mapped for owner reconciliation. */
export function createNaiveProxyServiceJudge(ctx: ServiceContext, deps: Omit<NaiveProxyJudgeDeps, 'recordCost'>): RubricJudge {
  const jobId = deps.jobId;
  const model = deps.model;
  function currentBudget() {
    if (!z.uuid().safeParse(jobId).success || ctx.jobId !== jobId || !Number.isSafeInteger(ctx.budgetMicroUsd) || ctx.budgetMicroUsd <= 0) unavailable();
  }
  const judge = createNaiveProxyJudge({
    ...deps,
    async authorize() { currentBudget(); return deps.authorize(); },
    async recordCost(receipt) {
      if (ctx.jobId !== jobId) unavailable();
      await ctx.recordCost(naiveProxyCostEntry(receipt, { jobId, model }));
    },
  });
  return async input => { currentBudget(); return judge(input); };
}
