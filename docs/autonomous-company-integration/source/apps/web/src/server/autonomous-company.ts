import 'server-only';
import { advanceAutonomousCompany, type CompanyPorts, type CompanyRequest } from '@ae/core/agents/autonomy/company';
import type { PostgresAutonomySupervisor, ReceiptLookup } from '@ae/core/agents/autonomy/supervisor';
import type { CommunicationProvider, PostgresCommunicationOutbox } from '@ae/core/agents/autonomy/communications';

/** Server composition root only. Configure once from authenticated accounts/policy/budgets;
 * never export config through a customer mutation, agent tool, or public route. */
export function createAutonomousCompanyServer(config: {
  authenticateScheduler(): Promise<boolean>;
  /** Read at most limit CURRENT authorized jobs; do not create replacement physical Workflow runs. */
  dueJobs(limit: number): Promise<CompanyRequest[]>;
  /** Resolve current tenant, payment, encrypted credentials, exact agent directory, data policy,
   * guarded target/judge, and outbox. All effects keep their existing durable identities. */
  portsFor(request: CompanyRequest): Promise<CompanyPorts>;
  supervisor: PostgresAutonomySupervisor;
  lookupReceipt: ReceiptLookup;
  outbox: PostgresCommunicationOutbox;
  /** No transport is enabled unless explicitly configured. Offline builds omit it. */
  notificationProvider?: CommunicationProvider;
  now(): number;
}) {
  return {
    async scheduledTick() {
      if (!await config.authenticateScheduler()) throw new Error('unauthorized_scheduler');
      const now = config.now(), jobs = await config.dueJobs(25);
      if (jobs.length > 25) throw new Error('unbounded_autonomous_job_scan');
      const outcomes: Array<{jobId: string; state: string; reason: string}> = [];
      for (const request of jobs) {
        // Each job's service and SQL ports recheck current authorization before every effect.
        try {
          const result = await advanceAutonomousCompany(request, await config.portsFor(request));
          outcomes.push({jobId: request.job.jobId, state: result.state, reason: result.reason});
        } catch {
          // Never turn an auth/storage/unknown-provider failure into a fresh dispatch.
          outcomes.push({jobId: request.job.jobId, state: 'exception', reason: 'current_guard_or_storage_refused'});
        }
      }
      const recovered = await config.supervisor.recoverDue(now, config.lookupReceipt,25);
      const messages = config.notificationProvider ? await config.outbox.recoverDue(config.notificationProvider,now) : [];
      const audit = await config.supervisor.dailyAudit(new Date(now).toISOString().slice(0,10));
      return {outcomes, recovered: recovered.length, messages: messages.length, audit};
    },
  };
}
