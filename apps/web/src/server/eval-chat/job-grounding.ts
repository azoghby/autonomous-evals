/** Pure grounding for a customer audit job (suite, findings, report, remediations), mirroring grounding.ts for runs. */
import { normalizeFinding, type FindingView, type RemediationView } from "@/lib/client/types";
import type { FindingEvidenceCard, JobSummaryCard } from "@/lib/eval-chat/types";
import { clip, GroundingError } from "./grounding";

export interface JobGroundingInput {
  job: { id: string; state: string; package: string; createdAt: string | Date; error?: string | null };
  findings: unknown[];
  remediations: Array<Pick<RemediationView, "id" | "findingRowId" | "summary" | "patch" | "rationale" | "kind"> & { verification?: { status?: string } }>;
  report?: { summary: string; markdown?: string } | null;
}

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export const jobFindings = (data: JobGroundingInput): FindingView[] => data.findings.map(normalizeFinding);

export function jobSummary(data: JobGroundingInput): JobSummaryCard {
  const findings = jobFindings(data);
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  return {
    jobId: data.job.id, state: data.job.state, package: data.job.package, createdAt: new Date(data.job.createdAt).toISOString(),
    findings: findings.slice(0, 20).map((f) => ({ id: f.id, title: clip(f.title, 200), severity: f.severity, status: f.status, category: f.category })),
    bySeverity, reportSummary: data.report?.summary ? clip(data.report.summary, 1_200) : null,
    remediations: data.remediations.length, delivered: data.job.state === "delivered",
  };
}

export function findFinding(data: JobGroundingInput, ref: string): FindingView {
  const findings = jobFindings(data);
  const q = ref.toLowerCase();
  const f = findings.find((x) => x.id === ref || x.key === ref) ?? findings.find((x) => x.title.toLowerCase().includes(q));
  if (!f) throw new GroundingError(`No finding "${clip(ref, 80)}" in this audit. Valid ids: ${findings.map((x) => x.id).join(", ") || "(none yet)"}`);
  return f;
}

export function findingEvidence(data: JobGroundingInput, ref: string): FindingEvidenceCard {
  const f = findFinding(data, ref);
  const rem = data.remediations.find((r) => r.findingRowId === f.id);
  return {
    findingId: f.id, title: f.title, severity: f.severity, status: f.status, category: f.category,
    description: clip(f.description, 1_200), reproductions: f.reproductions ?? null,
    evidence: f.evidence.slice(0, 5).map((e) => ({ label: e.location ? `${e.kind} · ${clip(e.location, 80)}` : e.kind, text: clip(e.excerpt, 800) })),
    remediation: rem ? { title: rem.kind.replace(/_/g, " "), summary: clip(rem.summary, 500), patch: rem.patch ? clip(rem.patch, 4_000) : null } : null,
  };
}

export function jobContext(data: JobGroundingInput): string {
  const s = jobSummary(data);
  return JSON.stringify({
    audit: { id: s.jobId, state: s.state, package: s.package, createdAt: s.createdAt, error: data.job.error ? clip(data.job.error, 300) : null },
    findings: jobFindings(data).slice(0, 25).map((f) => ({ id: f.id, title: clip(f.title, 160), severity: f.severity, status: f.status, category: f.category, scenarioId: f.scenarioId, reproductions: f.reproductions })),
    bySeverity: s.bySeverity,
    remediations: data.remediations.slice(0, 10).map((r) => ({ findingRowId: r.findingRowId, kind: r.kind, summary: clip(r.summary, 200), verification: r.verification?.status })),
    reportSummary: s.reportSummary,
  }).slice(0, 14_000);
}

export function jobSuggestions(data: JobGroundingInput): string[] {
  const f = jobFindings(data);
  const top = [...f].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))[0];
  const out: string[] = [];
  if (top) out.push(`Explain "${clip(top.title, 60)}"`);
  if (data.remediations.length) out.push("Which fixes were verified?");
  out.push("Summarize this audit in three bullets");
  if (top && data.job.state === "delivered") out.push(`Re-run the "${clip(top.title, 40)}" finding`);
  out.push("What does a confirmed finding mean?");
  return out.slice(0, 5);
}
