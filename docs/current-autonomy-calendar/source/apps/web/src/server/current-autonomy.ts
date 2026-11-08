import 'server-only';
import type { ServiceContext } from '@ae/core/contracts/services';
import type { CompanyRequest } from '@ae/core/agents/autonomy/company';
import { createAutonomyReleaseServer, type ReleaseConfig } from './autonomy-release';
import { createRichWorkflowServices } from './rich-services';
import type { Viewer } from './access';

type CurrentJob = { id: string; customerId: string; workflowRunId: string | null; environment: string; isMock: boolean };
type RichServices = Awaited<ReturnType<typeof createRichWorkflowServices>>;
export type CurrentAutonomyConfig = Omit<ReleaseConfig, 'authenticateCustomer' | 'authenticateScheduler' | 'authorizeJob' | 'evaluate'> & {
  /** Existing Workflow's context, with its durable budget/progress adapters. Never parsed from HTTP. */
  contextFor(request: CompanyRequest): Promise<ServiceContext>;
  /** Retained evaluation driver; must persist genuine result/receipt before acknowledgement. */
  evaluateWithServices(request: CompanyRequest, key: string, digest: string, services: RichServices): ReturnType<ReleaseConfig['evaluate']>;
};
export interface CurrentAutonomyDependencies {
  viewer(): Promise<Viewer | null>;
  cron(request: Request): Response | null;
  job(id: string): Promise<CurrentJob | null>;
  rich?: typeof createRichWorkflowServices;
}

/** Current-app boundary. Cookie viewer and canonical job ownership are resolved afresh on every
 * request; request bodies, operator privilege, payment assertions and legacy fallback grant nothing. */
export function createCurrentAutonomyApplication(config: CurrentAutonomyConfig, deps: CurrentAutonomyDependencies) {
  const scheduler = Symbol('authenticated-current-cron');
  const customer = Symbol('authenticated-current-customer');
  async function authorize(principal: { tenantId: string; subject: string }, request: CompanyRequest) {
    const job = await deps.job(request.job.jobId);
    return !!job && !job.isMock && !!job.workflowRunId && job.id === request.job.jobId
      && job.customerId === principal.subject && principal.tenantId === job.customerId
      && request.tenantId === job.customerId && request.job.customerId === job.customerId
      && request.job.environment === job.environment;
  }
  const release = createAutonomyReleaseServer({ ...config,
    async authenticateCustomer(credential) {
      if (credential !== customer) return null;
      const viewer = await deps.viewer();
      return viewer ? { tenantId: viewer.id, subject: viewer.id } : null;
    },
    async authenticateScheduler(credential) { return credential === scheduler; },
    authorizeJob: authorize,
    async evaluate(request, key, digest, _runner, paid) {
      // Paid Calendar dispatch is bound by the durable calendar engine identity hook.
      if (request.job.package !== 'text_eval' && request.job.package !== 'workflow_eval') throw new Error('autonomous_package_adapter_required');
      const job = await deps.job(request.job.jobId);
      if (!job?.workflowRunId || !await authorize({ tenantId: request.tenantId, subject: request.job.customerId }, request)) throw new Error('current_autonomy_authority_refused');
      const ctx = await config.contextFor(request);
      if (ctx.jobId !== job.id || ctx.environment !== job.environment) throw new Error('current_autonomy_context_refused');
      await paid.guard(request.job, config.db);
      const services = await (deps.rich ?? createRichWorkflowServices)(ctx, { workflowRunId: job.workflowRunId, autonomous: paid });
      return config.evaluateWithServices(request, key, digest, services);
    },
  });
  async function owner(jobId: string) {
    const viewer = await deps.viewer();
    if (!viewer) return Response.json({error:'Unauthorized'}, {status:401});
    const job = await deps.job(jobId);
    // Autonomous authority is personal ownership; the current operator read bypass does not mint it.
    if (!job || job.customerId !== viewer.id) return Response.json({error:'Not found'}, {status:404});
    return null;
  }
  async function result(action: () => Promise<unknown>) {
    try { return Response.json(await action(), {headers:{'Cache-Control':'private, no-store'}}); }
    catch { return Response.json({error:'Autonomous authority or owner adapter unavailable'}, {status:409}); }
  }
  return {
    /** Server-only durable step entry; no HTTP credential or capability is serialized. */
    async advanceDueJobs() { return release.scheduledTick(scheduler); },
    async bootstrap(_request: Request, jobId: string) {
      const denied = await owner(jobId); if (denied) return denied;
      return result(() => release.bootstrap(customer, jobId));
    },
    async publication(_request: Request, jobId: string) {
      const denied = await owner(jobId); if (denied) return denied;
      return result(() => release.publication(customer, jobId));
    },
    async tick(request: Request) {
      const denied = deps.cron(request); if (denied) return denied;
      return result(() => release.scheduledTick(scheduler));
    },
  };
}
