import 'server-only';
import { createHash } from 'node:crypto';
import { createGatewayJudge, type JudgeInput } from '@ae/core/judges/gateway';
import { containsSecret } from '@ae/core/agents/redact';
import { ROLE_DEFINITIONS } from '@ae/core/agents/roles';
import { PRICE_TABLE } from '@ae/core/evals/pricing';
import type { JobRef } from '@ae/core/evals/types';
import type { TextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import type { RemediationAccountingDeps } from '@ae/core/evals/remediation/accounting/index';
import { canonicalJson } from '@ae/core/evals/text/index';
import { JudgeAccounting } from './judge-accounting';

export interface JudgePolicy {
  model: string; configVersion: string; privateKeyRef: string; reservationMicroUsd: number;
  periodId: string; auth: 'api_key' | 'oidc';
}
export interface TrustedJudgeRuntime {
  signal: AbortSignal;
  beforeDispatch(intent: { kind: 'gateway'; operationId: string }): Promise<void>;
  token(ref: string, auth: JudgePolicy['auth']): Promise<string>;
  /** Offline fixtures only; production uses the secured, fixed Gateway URL in createGatewayJudge. */
  fetch?: typeof fetch;
}
const refuse = (): never => { throw new Error('judge_reconciliation_required'); };
export function createTrustedJudgeResolver(deps: {
  sql: RemediationAccountingDeps['sql']; checkpoints: TextCheckpointStore;
  canonical(): Promise<{ job: JobRef; knownSecrets: readonly string[]; targetVersion: string }>;
  policy: JudgePolicy; runtime: TrustedJudgeRuntime; deliverCost: RemediationAccountingDeps['deliverCost'];
}) {
  const policy = Object.freeze({ ...deps.policy });
  if (!policy.model.trim() || !policy.configVersion || !policy.privateKeyRef || !/^[A-Za-z0-9_-]+$/.test(policy.periodId)
    || !Number.isSafeInteger(policy.reservationMicroUsd) || policy.reservationMicroUsd <= 0
    || !['api_key','oidc'].includes(policy.auth)) refuse();
  return async (raw: JudgeInput) => {
    const input = structuredClone(raw);
    let privateToken: string | undefined;
    const a = await deps.canonical();
    function safe(value: unknown, secrets = a.knownSecrets) { if (containsSecret(JSON.stringify(value), [...secrets, ...(privateToken ? [privateToken] : [])])) refuse(); }
    safe(input);
    const digest = createHash('sha256').update(canonicalJson({ input, policy, job: a.job, targetVersion: a.targetVersion })).digest('hex');
    const operationId = `workflow-judge:${a.job.jobId}:${input.operationId}`;
    const op = { operationId, kind: 'judge' as const, inputDigest: digest };
    const key = { jobId: a.job.jobId, kind: 'gateway_judge', id: operationId, inputDigest: digest };
    const accounting = new JudgeAccounting({ sql: deps.sql, jobId: a.job.jobId, deliverCost: deps.deliverCost,
      reservation: () => ({ reservationId: operationId, jobId: a.job.jobId, amountMicroUsd: policy.reservationMicroUsd, scopes: [
        { key: `job:${a.job.jobId}`, capMicroUsd: PRICE_TABLE[a.job.package].jobBudgetMicroUsd },
        { key: `agent:evaluation_engineer:${policy.periodId}`, capMicroUsd: ROLE_DEFINITIONS.evaluation_engineer.periodCapMicroUsd },
      ] }) });
    async function current() {
      deps.runtime.signal.throwIfAborted();
      const latest = await deps.canonical();
      if (canonicalJson(latest.job) !== canonicalJson(a.job) || latest.targetVersion !== a.targetVersion) refuse();
      safe(input, latest.knownSecrets);
      return latest;
    }
    const claim = await deps.checkpoints.claim(key);
    if (claim.state === 'completed') { const latest = await current(); safe(claim.value, latest.knownSecrets); return claim.value as Awaited<ReturnType<ReturnType<typeof createGatewayJudge>>>; }
    if (claim.state !== 'claimed') return refuse();
    let dispatched = false;
    try {
      const judge = createGatewayJudge({ model: policy.model,
        token: async () => { await current(); privateToken = await deps.runtime.token(policy.privateKeyRef, policy.auth); safe(input); return privateToken; },
        authorize: async () => {
          await current();
          if (!await accounting.authorize(op)) refuse();
          await accounting.claim(op);
        },
        fetch: async (url, init) => {
          // Core fixes URL/model/max_tokens/redirect; combine its timeout with parent cancellation.
          if (url !== 'https://ai-gateway.vercel.sh/v1/chat/completions' || !init?.signal) return refuse();
          const signal = AbortSignal.any([deps.runtime.signal, init.signal]);
          await current();
          await deps.runtime.beforeDispatch({ kind: 'gateway', operationId });
          const latest = await current();
          safe(init.body, latest.knownSecrets);
          signal.throwIfAborted();
          dispatched = true;
          return (deps.runtime.fetch ?? fetch)(url, { ...init, signal });
        },
        recordUsage: async usage => {
          const receipt = { ...usage, operationId }; safe(receipt);
          await accounting.observed(op, receipt);
          // Retain the actual provider ID/model/tokens for owner reconciliation in the existing store.
          const usageKey = { ...key, kind: 'gateway_judge_usage' };
          const saved = await deps.checkpoints.claim(usageKey);
          if (saved.state === 'claimed') await deps.checkpoints.complete(usageKey, saved.token, receipt);
          else if (saved.state !== 'completed' || canonicalJson(saved.value) !== canonicalJson(receipt)) refuse();
        },
      });
      const verdict = await judge(input);
      const latest = await current(); safe(verdict, latest.knownSecrets);
      await deps.checkpoints.complete(key, claim.token, verdict);
      return verdict;
    } catch {
      if (dispatched) await accounting.ambiguous(op).catch(() => undefined);
      await deps.checkpoints.markAmbiguous(key, claim.token).catch(() => undefined);
      return refuse();
    }
  };
}

/** Only server deployment configuration selects the model and private credential reference.
 * No customer input or route accepts this policy or credentials. */
export function workflowJudgePolicy(): JudgePolicy {
  const auth = process.env.WORKFLOW_JUDGE_AUTH;
  if (auth !== 'api_key' && auth !== 'oidc') return refuse();
  return { model: process.env.WORKFLOW_JUDGE_MODEL ?? '', configVersion: process.env.WORKFLOW_JUDGE_CONFIG_VERSION ?? '',
    reservationMicroUsd: Number(process.env.WORKFLOW_JUDGE_RESERVATION_MICRO_USD), periodId: process.env.NAIVE_BUDGET_PERIOD_ID ?? '',
    auth, privateKeyRef: auth === 'api_key' ? 'AI_GATEWAY_API_KEY' : 'VERCEL_OIDC_TOKEN' };
}
export function workflowJudgeRuntime(): TrustedJudgeRuntime {
  let dispatched = 0;
  return { signal: AbortSignal.timeout(180000), beforeDispatch: async () => { if (++dispatched > 16) refuse(); }, token: async (ref, auth) => {
    if (ref !== (auth === 'api_key' ? 'AI_GATEWAY_API_KEY' : 'VERCEL_OIDC_TOKEN')) return refuse();
    const token = process.env[ref];
    if (!token) return refuse();
    return token;
  } };
}
