/**
 * Stale-job recovery: pure selection + decision logic (no I/O) and a small orchestrator driven by injected deps.
 *
 * Recovery: a live run whose queue message was dropped is nudged with reenqueueRun (replay is deterministic, steps
 * durable). A dead run is restarted via restartJobWorkflow, which resumes from persisted DB state (workflows/job.ts +
 * decideResumePlan); if it refuses (held/inconsistent state) or attempts hit the cap, the job is escalated to an operator.
 */

export const WORKING_STATES = ["planning", "running", "investigating"] as const;
export const WORKING_STALE_MS = 15 * 60_000;
export const PAID_NOT_RESUMED_MS = 5 * 60_000;
export const MAX_RECOVERY_ATTEMPTS = 3;
export const BATCH_LIMIT = 25;
/** Cron-written milestones; they never count as real progress. */
export const FLAG_MILESTONE = "stale_flagged";
export const RECOVERY_MILESTONE = "stale_recovery";
export const CRON_MILESTONES: readonly string[] = [FLAG_MILESTONE, RECOVERY_MILESTONE, "authorization_expiring"];

export type StaleKind = "working" | "paid_not_resumed";
export type Liveness = "alive" | "dead" | "unknown";
export type RecoveryAction = "skip" | "reenqueue" | "resume_payment" | "restart" | "escalate";

export interface StaleCandidate {
  jobId: string;
  state: string;
  updatedAt: Date;
  /** Latest non-cron progress event. */
  lastProgressAt: Date | null;
  /** Timestamps of prior recovery attempts (stale_recovery events). */
  recoveryAt: Date[];
  /** Latest stale_flagged event (operator already alerted). */
  escalatedAt: Date | null;
  /** A paid one-time payment on the job whose workflow_resumed_at is still null. */
  unresumedPayment: { id: string; createdAt: Date } | null;
  /** A paid one-time payment on the job that was already delivered to the workflow. */
  hasResumedPayment: boolean;
}

export const lastActivityMs = (c: StaleCandidate): number =>
  Math.max(c.updatedAt.getTime(), c.lastProgressAt?.getTime() ?? 0);

/** Recovery attempts made since the job last made real progress. */
export const attemptsSinceProgress = (c: StaleCandidate): number => {
  const since = lastActivityMs(c);
  return c.recoveryAt.filter((d) => d.getTime() > since).length;
};

/** Which stale class (if any) the job falls in right now. Ignores attempt/backoff state. */
export function classify(c: StaleCandidate, now: number): StaleKind | null {
  const idle = now - lastActivityMs(c);
  if ((WORKING_STATES as readonly string[]).includes(c.state)) return idle >= WORKING_STALE_MS ? "working" : null;
  if (c.state !== "awaiting_payment") return null;
  if (c.unresumedPayment) {
    return now - c.unresumedPayment.createdAt.getTime() >= PAID_NOT_RESUMED_MS && idle >= PAID_NOT_RESUMED_MS ? "paid_not_resumed" : null;
  }
  // Payment was handed to the workflow but the job never left awaiting_payment.
  return c.hasResumedPayment && idle >= WORKING_STALE_MS ? "working" : null;
}

/** Jobs to act on this tick: stale, not already escalated since last progress, past their retry backoff; oldest first, bounded. */
export function selectStale(candidates: StaleCandidate[], now: number, limit = BATCH_LIMIT): Array<{ candidate: StaleCandidate; kind: StaleKind }> {
  const picked: Array<{ candidate: StaleCandidate; kind: StaleKind; idle: number }> = [];
  for (const candidate of candidates) {
    const kind = classify(candidate, now);
    if (!kind) continue;
    const activity = lastActivityMs(candidate);
    if (candidate.escalatedAt && candidate.escalatedAt.getTime() > activity) continue;
    const backoff = kind === "paid_not_resumed" ? PAID_NOT_RESUMED_MS : WORKING_STALE_MS;
    const lastAttempt = Math.max(0, ...candidate.recoveryAt.filter((d) => d.getTime() > activity).map((d) => d.getTime()));
    if (lastAttempt && now - lastAttempt < backoff) continue;
    picked.push({ candidate, kind, idle: now - activity });
  }
  return picked.sort((a, b) => b.idle - a.idle).slice(0, limit).map(({ candidate, kind }) => ({ candidate, kind }));
}

/** What to do for a selected job. `liveness` is only consulted for working jobs. */
export function decideRecovery(kind: StaleKind, liveness: Liveness, attempts: number): RecoveryAction {
  if (kind === "paid_not_resumed") return attempts >= MAX_RECOVERY_ATTEMPTS ? "escalate" : "resume_payment";
  if (liveness === "unknown") return "skip"; // Workflow API hiccup: try again next tick, do not burn an attempt.
  if (liveness === "dead") return attempts >= MAX_RECOVERY_ATTEMPTS ? "escalate" : "restart"; // job.ts resumes from DB state (workflows/restart.ts).
  return attempts >= MAX_RECOVERY_ATTEMPTS ? "escalate" : "reenqueue";
}

export function escalationNote(kind: StaleKind, liveness: Liveness, attempts: number, idleMinutes: number): string {
  if (kind === "paid_not_resumed") {
    return `Stale job: payment received but the workflow was not resumed after ${attempts} attempts (idle ${idleMinutes} min). Check the payment and workflow hook; not restarted automatically.`;
  }
  return liveness === "dead"
    ? `Stale job: no progress for ${idleMinutes} min and the workflow run is no longer active. Jobs are not safely restartable; operator must resolve (refund, fail, or re-run). Not restarted automatically.`
    : `Stale job: no progress for ${idleMinutes} min; ${attempts} automatic re-enqueue attempts did not move it. Operator review needed.`;
}

export interface StaleJobDeps {
  liveness(jobId: string): Promise<Liveness>;
  reenqueue(jobId: string): Promise<void>;
  resumePayment(paymentId: string): Promise<void>;
  recordAttempt(jobId: string, message: string): Promise<void>;
  escalate(jobId: string, note: string): Promise<void>;
  /** Restarts a dead run from persisted state. */
  restart(jobId: string): Promise<{ status: "restarted" | "alreadyRunning" | "notRestartable"; reason: string }>;
}

export interface StaleJobsSummary {
  checked: number;
  reenqueued: string[];
  restarted: string[];
  paymentsResumed: string[];
  escalated: string[];
  skipped: string[];
  errors: string[];
}

/** Applies decideRecovery to a bounded batch. One job's failure never blocks the others. */
export async function processStaleJobs(candidates: StaleCandidate[], now: number, deps: StaleJobDeps): Promise<StaleJobsSummary> {
  const summary: StaleJobsSummary = { checked: candidates.length, reenqueued: [], restarted: [], paymentsResumed: [], escalated: [], skipped: [], errors: [] };
  for (const { candidate: c, kind } of selectStale(candidates, now)) {
    try {
      const liveness = kind === "working" ? await deps.liveness(c.jobId) : "alive";
      const attempts = attemptsSinceProgress(c);
      const action = decideRecovery(kind, liveness, attempts);
      const idleMinutes = Math.round((now - lastActivityMs(c)) / 60_000);
      if (action === "skip") { summary.skipped.push(c.jobId); continue; }
      if (action === "escalate") {
        await deps.escalate(c.jobId, escalationNote(kind, liveness, attempts, idleMinutes));
        summary.escalated.push(c.jobId);
        continue;
      }
      // Record the attempt first so a crash mid-action still counts toward the cap.
      await deps.recordAttempt(c.jobId, `Automatic recovery attempt ${attempts + 1}/${MAX_RECOVERY_ATTEMPTS} (${action}, idle ${idleMinutes} min).`);
      if (action === "reenqueue") { await deps.reenqueue(c.jobId); summary.reenqueued.push(c.jobId); }
      else if (action === "restart") {
        const r = await deps.restart(c.jobId);
        if (r.status === "notRestartable") {
          await deps.escalate(c.jobId, `${escalationNote(kind, liveness, attempts, idleMinutes)} Restart refused: ${r.reason}`);
          summary.escalated.push(c.jobId);
        } else summary.restarted.push(c.jobId);
      }
      else if (c.unresumedPayment) { await deps.resumePayment(c.unresumedPayment.id); summary.paymentsResumed.push(c.jobId); }
    } catch (err) {
      summary.errors.push(`${c.jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return summary;
}
