import 'server-only';
import type { CurrentAutonomyConfig, CurrentAutonomyDependencies } from './current-autonomy';
import { createCurrentAutonomyApplication } from './current-autonomy';
import { createCurrentPaymentBridge, type BridgeOptions } from './current-payment';
import { currentStripePaymentOptions } from './current-stripe-payment';

/** Deliberately excludes payment/request authority: only this canonical bridge supplies those. */
export interface CurrentOwnerAdapters {
  config: Omit<CurrentAutonomyConfig, 'loadRequest' | 'verifyPayment' | 'paymentStillValid' | 'enqueue'>;
  bridge: Omit<BridgeOptions,'verifyStripe'>;
  dependencies: CurrentAutonomyDependencies;
  enqueue: CurrentAutonomyConfig['enqueue'];
  /** Must read the durable canonical dispatch owner; signed payment alone cannot authorize a second evaluator. */
  exclusiveDispatch: (request: Parameters<CurrentAutonomyConfig['contextFor']>[0]) => Promise<boolean>;
  /** Durable consented outbox must expose the actual checkout action to the owner. */
  enqueueQuote(
    request: Parameters<CurrentAutonomyConfig['enqueue']>[0], key: string,
    quote: Extract<Parameters<CurrentAutonomyConfig['enqueue']>[2],{kind:'quote'}>['quote'],
    checkout: Awaited<ReturnType<ReturnType<typeof createCurrentPaymentBridge>['prepareQuote']>>,
    paid: Parameters<CurrentAutonomyConfig['enqueue']>[3],
  ): Promise<void>;
}

/** Construct in the request/step isolate. No process-global installation, serialized credentials,
 * user JSON factory, or automatic legacy fallback. Factories themselves perform no provider I/O. */
export function createCurrentPaymentStartup(owner: CurrentOwnerAdapters) {
  if (owner.config.db !== owner.bridge.sql) throw new Error('current_payment_transaction_adapter_mismatch');
  const bridge = createCurrentPaymentBridge(currentStripePaymentOptions(owner.bridge));
  const config: CurrentAutonomyConfig = {
    ...owner.config,
    async contextFor(request) {
      if (!await owner.exclusiveDispatch(request)) throw new Error('current_payment_exclusive_dispatch_required');
      return owner.config.contextFor(request);
    },
    async evaluateWithServices(request, key, digest, services) {
      if (!await owner.exclusiveDispatch(request)) throw new Error('current_payment_exclusive_dispatch_required');
      return owner.config.evaluateWithServices(request, key, digest, services);
    },
    loadRequest: bridge.loadRequest,
    verifyPayment: bridge.verifyPayment,
    paymentStillValid: bridge.paymentStillValid,
    async enqueue(request, key, message, paid) {
      // A quote is offered, never accepted. The human/customer agent still calls the existing
      // owner-authenticated accept-quote endpoint to start the real fixed-price Stripe checkout.
      if (message.kind === 'quote') {
        const checkout = await bridge.prepareQuote(request, message.quote);
        return owner.enqueueQuote(request, key, message.quote, checkout, paid);
      }
      return owner.enqueue(request, key, message, paid);
    },
  };
  const application = createCurrentAutonomyApplication(config, owner.dependencies);
  return {
    bridge,
    application,
    publication: application.publication,
    tick: application.tick,
    async bootstrap(request: Request, jobId: string) {
      const result = await application.bootstrap(request, jobId);
      if (result.ok) {
        // Receipts may arrive before bootstrap. Resolve owner again; never consume a client tenant.
        const viewer = await owner.dependencies.viewer();
        if (!viewer) return Response.json({error:'Authentication changed'}, {status:401});
        const canonical = await bridge.loadRequest({tenantId:viewer.id,subject:viewer.id}, jobId);
        if (!canonical) return Response.json({error:'Current job authority changed'}, {status:409});
        await bridge.drainReceipts(canonical.tenantId, jobId);
      }
      return result;
    },
    async advanceDueJobs() {
      // Each payment lookup rechecks and drains retained receipts; no workflow hook replay needed.
      await bridge.drainPendingReceipts();
      return application.advanceDueJobs();
    },
  };
}
export type CurrentPaymentStartup = ReturnType<typeof createCurrentPaymentStartup>;
export type CurrentOwnerLoader = () => Promise<
  | {status:'ready'; adapters:CurrentOwnerAdapters}
  | {status:'blocked'; missing:readonly string[]}
>;

export function createCurrentIsolateStartup(load: CurrentOwnerLoader) {
  // Cache configuration, not an authenticated principal. Authorization remains request-local.
  let pending: Promise<CurrentPaymentStartup | null> | undefined;
  return async () => {
    pending ??= load().then(result => result.status === 'ready' ? createCurrentPaymentStartup(result.adapters) : null);
    try { return await pending; }
    catch (error) { pending = undefined; throw error; }
  };
}
