import "server-only";
import { assertPublicTarget } from "./target-url";
import { and, desc, eq, ne } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { MONITORING_RUN_BUDGET_MICRO_USD, Suite } from "@ae/core/contracts/index";
import type { RunResult } from "@ae/core/contracts/services";
import { isEmailConfigured, sendEmail } from "@ae/core/auth/email";
import { readJobArtifactText } from "@ae/core/storage/blob";
import { addMessage, getJobWithDecryptedCredentials, makeServiceContext } from "./job-store";
import { recordEmailThread } from "./email-threads";
import { getEvalServices } from "./services";

export const MONITORING_CONCURRENCY = 2;
export const MONITORING_DEADLINE_MS = 250_000;
const DETAIL_MAX = 200;

export type ScenarioResult = RunResult["results"][number];

export interface MonitoringOptions {
  /** Injectable clock for tests. */
  now?: () => Date;
  deadlineMs?: number;
  concurrency?: number;
}

export interface MonitoringSkip { subscriptionId: string; reason: string }

export interface MonitoringSummary {
  processed: number;
  sent: number;
  skipped: number;
  errors: string[];
  skippedDetail: MonitoringSkip[];
}

type Outcome = { kind: "processed"; sent: boolean; emailSkipReason?: string } | { kind: "skipped"; reason: string };

/** Scenarios that passed in `prev` and fail in `curr`. No previous run (baseline) means no regressions. */
export function detectRegressions(prev: ScenarioResult[] | null | undefined, curr: ScenarioResult[]): ScenarioResult[] {
  if (!prev || prev.length === 0) return [];
  const passedBefore = new Set(prev.filter((r) => r.passed).map((r) => r.scenarioId));
  return curr.filter((r) => !r.passed && passedBefore.has(r.scenarioId));
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export const monitoringEnvironment = (): "live" | "test" => (process.env.STRIPE_MODE === "live" ? "live" : "test");

const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The endpoint that represents the current target: version comparisons monitor the newer version (B). */
export function targetFromIntake(intake: unknown): { url: string; model: string; apiKey?: string; systemPrompt: string } | null {
  const i = intake as Record<string, { url?: string; model?: string; apiKey?: string; systemPrompt?: string } | undefined>;
  const ep = i.endpoint ?? i.endpointB;
  if (!ep?.url || !ep.model) return null;
  return { url: ep.url, model: ep.model, apiKey: ep.apiKey, systemPrompt: ep.systemPrompt ?? "" };
}

export function buildRegressionEmail(jobId: string, regressed: ScenarioResult[]): { subject: string; text: string } {
  const lines = regressed.map((r) => `- ${r.scenarioId}: ${truncate(r.detail ?? "", DETAIL_MAX)}`);
  const n = regressed.length;
  return {
    subject: `Standard Evals monitoring: ${n} regression${n === 1 ? "" : "s"} detected`,
    text: [
      "Hello,",
      "",
      `Last night's re-run of your frozen test suite found ${n} scenario${n === 1 ? "" : "s"} that passed in the previous run and now fail:`,
      "",
      ...lines,
      "",
      `Details: ${appUrl()}/jobs/${jobId}`,
      "",
      "Failures can come from a change to your agent or from variability in the model, so please check before acting on a single result.",
      "",
      "Standard Evals (written by an AI agent)",
    ].join("\n"),
  };
}

async function notifyRegressions(
  sub: typeof schema.monitoringSubscriptions.$inferSelect, regressed: ScenarioResult[],
): Promise<{ sent: boolean; emailSkipReason?: string }> {
  const { subject, text } = buildRegressionEmail(sub.jobId, regressed);
  await addMessage(sub.jobId, "commercial", `Monitoring: ${regressed.length} regression(s): ${regressed.map((r) => r.scenarioId).join(", ")}`);
  if (!isEmailConfigured()) return { sent: false, emailSkipReason: "email_not_configured" };
  const [customer] = await db().select({ email: schema.customers.email }).from(schema.customers)
    .where(eq(schema.customers.id, sub.customerId)).limit(1);
  if (!customer?.email) return { sent: false, emailSkipReason: "customer_email_missing" };
  // email_threads stores thread ids only (no message id to reply to), so each alert starts a tracked thread.
  const sent = await sendEmail({ to: customer.email, subject, text, purpose: "commercial" });
  await recordEmailThread(sent.threadId, "commercial", { jobId: sub.jobId });
  return { sent: true };
}

async function processSubscription(
  sub: typeof schema.monitoringSubscriptions.$inferSelect, today: string,
): Promise<Outcome> {
  const [existing] = await db().select({ id: schema.monitoringRuns.id }).from(schema.monitoringRuns)
    .where(and(eq(schema.monitoringRuns.subscriptionId, sub.id), eq(schema.monitoringRuns.runDate, today))).limit(1);
  if (existing) return { kind: "skipped", reason: "already_ran_today" };

  const full = await getJobWithDecryptedCredentials(sub.jobId);
  if (!full) return { kind: "skipped", reason: "job_not_found" };
  const { job, intake } = full;
  if (job.isMock && process.env.MONITORING_INCLUDE_MOCK !== "1") return { kind: "skipped", reason: "mock_job" };
  if (job.package === "trace_audit") return { kind: "skipped", reason: "trace_audit_has_no_suite" };
  if (!job.suiteBlobPath) return { kind: "skipped", reason: "no_frozen_suite" };

  const text = await readJobArtifactText(job.suiteBlobPath);
  if (text === null) return { kind: "skipped", reason: "suite_blob_missing" };
  const suite = Suite.parse(JSON.parse(text));

  const target = targetFromIntake(intake);
  if (!target) return { kind: "skipped", reason: "intake_has_no_endpoint" };
  if (await assertPublicTarget(target.url)) return { kind: "skipped", reason: "target_rejected" };
  const needsKey = Array.isArray((intake as unknown as { _credentialSlots?: unknown })._credentialSlots);
  if (!target.apiKey && !full.credentialsPresent && needsKey) {
    // Credentials are deleted after delivery; a target that needed a key cannot be re-run.
    return { kind: "skipped", reason: "credentials_deleted" };
  }

  const ctx = { ...(await makeServiceContext(sub.jobId)), budgetMicroUsd: MONITORING_RUN_BUDGET_MICRO_USD };
  const run = await (await getEvalServices()).runSuite(ctx, suite, target);

  const [prev] = await db().select({ results: schema.monitoringRuns.results }).from(schema.monitoringRuns)
    .where(and(eq(schema.monitoringRuns.subscriptionId, sub.id), ne(schema.monitoringRuns.runDate, today)))
    .orderBy(desc(schema.monitoringRuns.runDate)).limit(1);
  const regressed = detectRegressions(prev?.results as ScenarioResult[] | undefined, run.results);

  const inserted = await db().insert(schema.monitoringRuns).values({
    subscriptionId: sub.id, jobId: sub.jobId, runDate: today, results: run.results, regressions: regressed.length,
  }).onConflictDoNothing().returning({ id: schema.monitoringRuns.id });
  await db().update(schema.monitoringSubscriptions).set({ lastRunAt: new Date() })
    .where(eq(schema.monitoringSubscriptions.id, sub.id));
  // A concurrent invocation won the insert: it owns the email.
  if (inserted.length === 0) return { kind: "skipped", reason: "already_ran_today" };

  if (regressed.length === 0) return { kind: "processed", sent: false };
  const n = await notifyRegressions(sub, regressed);
  return { kind: "processed", ...n };
}

export async function runMonitoring(opts: MonitoringOptions = {}): Promise<MonitoringSummary> {
  const now = opts.now ?? (() => new Date());
  const started = now().getTime();
  const deadline = started + (opts.deadlineMs ?? MONITORING_DEADLINE_MS);
  const today = utcDay(now());
  const summary = { processed: 0, sent: 0, skipped: 0, errors: [] as string[], skippedDetail: [] as MonitoringSkip[] };
  const skip = (subscriptionId: string, reason: string) => {
    summary.skipped++;
    summary.skippedDetail.push({ subscriptionId, reason });
  };

  const subs = await db().select().from(schema.monitoringSubscriptions).where(and(
    eq(schema.monitoringSubscriptions.status, "active"),
    eq(schema.monitoringSubscriptions.environment, monitoringEnvironment()),
  ));

  const queue = [...subs];
  const worker = async () => {
    for (let sub = queue.shift(); sub; sub = queue.shift()) {
      if (now().getTime() >= deadline) { skip(sub.id, "deadline"); continue; }
      try {
        const out = await processSubscription(sub, today);
        if (out.kind === "skipped") { skip(sub.id, out.reason); continue; }
        summary.processed++;
        if (out.sent) summary.sent++;
        else if (out.emailSkipReason) skip(sub.id, out.emailSkipReason);
      } catch (err) {
        summary.errors.push(`${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? MONITORING_CONCURRENCY) }, worker));
  return summary;
}
