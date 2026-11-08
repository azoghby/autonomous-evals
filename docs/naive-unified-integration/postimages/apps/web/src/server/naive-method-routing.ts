import { TextFactualGapError } from '@ae/core/evals/text/factual-gap';
import { FatalError } from 'workflow';
import type { EvalServices, ServiceContext } from '@ae/core/contracts/services';
import { EvalServiceConfigError, EvalServiceUnavailableError, TrackBBlockedError, TrackBPendingError } from '@ae/core/integration/eval-services';

export const naiveMethods = ['designSuite', 'runSuite', 'investigate', 'proposeAndVerifyFix', 'rerunFinding'] as const;
export type NaiveMethod = typeof naiveMethods[number];
export type NaiveMethodBuilder = (method: NaiveMethod, ctx: ServiceContext) => Promise<Partial<Pick<EvalServices, NaiveMethod>>>;
export type RoutingSelection = { methods: ReadonlySet<NaiveMethod>; realBranches?: boolean };
export function readRoutingSelection(env: Record<string, string | undefined> = process.env): RoutingSelection {
  const raw = env.EVAL_NAIVE_METHODS;
  const methods = new Set<NaiveMethod>();
  if (raw !== undefined && raw !== '') {
    for (const item of raw.split(',')) {
      if (!naiveMethods.includes(item as NaiveMethod) || methods.has(item as NaiveMethod)) {
        throw new EvalServiceConfigError(`Invalid EVAL_NAIVE_METHODS selection: ${item}`, ["EVAL_NAIVE_METHODS"]);
      }
      methods.add(item as NaiveMethod);
    }
  }
  const flag = env.EVAL_REAL_BRANCHES;
  if (flag !== undefined && flag !== '0' && flag !== '1') throw new EvalServiceConfigError('EVAL_REAL_BRANCHES must be 0 or 1', ['EVAL_REAL_BRANCHES']);
  if (methods.size && env.EVAL_SERVICES !== 'real') throw new EvalServiceConfigError('Selected Naive methods require EVAL_SERVICES=real', ['EVAL_SERVICES']);
  return { methods, realBranches: flag === undefined ? undefined : flag === '1' };
}
export function selectedNaiveMethod(method: NaiveMethod): boolean { return readRoutingSelection().methods.has(method); }
export function selectedNaiveEvaluation(): boolean {
  const { methods } = readRoutingSelection();
  return ['designSuite', 'runSuite', 'investigate'].some(m => methods.has(m as NaiveMethod));
}
export function requireNaivePackage(pkg: string, selection = readRoutingSelection()): void {
  if (selection.methods.size && pkg !== 'text_eval') throw new EvalServiceUnavailableError("genericNaive", `Selected generic Naive evaluation does not support ${pkg}`);
}
/** A selected owner operation parks in one durable Workflow instead of consuming step retries. */
export function toNaiveWorkflowError(error: unknown): unknown {
  // Private step captures the typed proposal before Workflow error serialization.
  if (error instanceof TextFactualGapError) return error;
  if (error instanceof TrackBBlockedError && error.code === 'needs_operator') {
    return new FatalError('NAIVE_RECONCILIATION_REQUIRED');
  }
  if (error instanceof TrackBPendingError) {
    const admission = ['Generic text design admission pending.', 'Text design admission is pending.'].includes(error.reason);
    return new FatalError(`${admission ? 'NAIVE_ADMISSION_PENDING' : 'NAIVE_OPERATION_PENDING'}: ${error.message}`);
  }
  return error;
}
/** The injected builder is an owner-authorized composition boundary, never a lite fallback. */
export function routeNaiveMethods(legacy: EvalServices, branches: EvalServices, selection: RoutingSelection, builder: NaiveMethodBuilder): EvalServices {
  const out = { ...legacy };
  for (const method of selection.methods) {
    const invoke = async (ctx: ServiceContext, ...args: unknown[]) => {
      if (!Number.isSafeInteger(ctx.budgetMicroUsd) || ctx.budgetMicroUsd <= 0) throw new TrackBBlockedError('paused_budget', 'Naive method requires a positive finite reserved budget');
      try {
        const built = await builder(method, ctx);
        const fn = built[method];
        if (typeof fn !== 'function') throw new EvalServiceUnavailableError(method, `Selected Naive method ${method} has no owner builder`);
        return await (fn as (...args: unknown[]) => Promise<unknown>).apply(built, [ctx, ...args]);
      } catch (error) {
        throw toNaiveWorkflowError(error);
      }
    };
    (out as unknown as Record<string, unknown>)[method] = invoke;
  }
  if (selection.realBranches !== undefined) {
    for (const method of ['createJobBranch', 'deleteJobBranch', 'getJobBranchConnection'] as const) {
      if (selection.realBranches) (out as unknown as Record<string, unknown>)[method] = branches[method]?.bind(branches) ?? (async () => { throw new EvalServiceUnavailableError(method, "Real branch method unavailable"); });
      else (out as unknown as Record<string, unknown>)[method] = async () => { throw new EvalServiceUnavailableError(method, 'Real simulator branches are disabled'); };
    }
  }
  return out;
}
export const unavailableNaiveBuilder: NaiveMethodBuilder = async method => {
  throw new EvalServiceUnavailableError(method, `Selected Naive method ${method} requires an installed owner builder`);
};
