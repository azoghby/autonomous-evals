/**
 * Service signatures Track B implements and Track A's workflow calls.
 * Services return validated data; the workflow decides sequencing.
 */
import type { Finding, IntakeInput, QualifyResult, Remediation, Report, Scenario, Suite, CostEntry } from "./index";

export interface ServiceContext {
  jobId: string;
  environment: "live" | "test";
  /** Remaining reserved budget for this job in micro-USD. */
  budgetMicroUsd: number;
  recordCost(entry: Omit<CostEntry, "jobId">): Promise<void>;
  recordProgress(milestone: string, message: string): Promise<void>;
}

export interface TraceAuditResult { findings: Finding[]; claimsChecked: number }
export interface RunResult { runId: string; versionLabel: string; results: Array<{ scenarioId: string; passed: boolean; detail: string }> }

export interface EvalServices {
  qualify(ctx: ServiceContext, intake: IntakeInput, clarifications: string[]): Promise<QualifyResult>;
  auditTrace(ctx: ServiceContext, trace: string, systemPrompt?: string): Promise<TraceAuditResult>;
  checkTarget(ctx: ServiceContext, endpoint: { url: string; model: string; apiKey?: string }): Promise<{ ok: boolean; detail: string }>;
  designSuite(ctx: ServiceContext, intake: IntakeInput): Promise<Suite>;
  runSuite(ctx: ServiceContext, suite: Suite, target: { url: string; model: string; apiKey?: string; systemPrompt: string }, branchConnString?: string): Promise<RunResult>;
  investigate(ctx: ServiceContext, suite: Suite, runs: RunResult[]): Promise<Finding[]>;
  renderReport(ctx: ServiceContext, input: { intake: IntakeInput; findings: Finding[]; suite?: Suite; remediations?: Remediation[] }): Promise<Report>;
  createJobBranch(jobId: string): Promise<{ branchId: string; connectionString: string }>;
  deleteJobBranch(branchId: string): Promise<void>;
  /** Proposes a concrete fix for a confirmed finding and verifies it by re-running the relevant frozen scenario(s) / trace re-check with the patch applied. */
  proposeAndVerifyFix(ctx: ServiceContext, input: { finding: Finding; suite?: Suite; intake: IntakeInput }): Promise<Remediation>;
  rerunFinding(ctx: ServiceContext, finding: Finding, scenario: Scenario | undefined): Promise<Finding>;
}
