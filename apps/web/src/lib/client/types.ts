import type { Environment, JobState, Package } from "@ae/core/contracts/index";

export interface JobSummary {
  id: string;
  package: Package;
  state: JobState;
  environment: Environment;
  priceCents?: number | null;
  createdAt: string;
}

export interface QuoteView {
  version: number;
  package: Package;
  priceCents: number;
  scopeSummary: string;
  deliverables: string[];
  environment?: Environment;
  acceptedAt?: string | null;
}

export interface MessageView {
  id: string;
  role: "customer" | "commercial" | "operator" | "system" | string;
  body: string;
  createdAt: string;
}

export interface ProgressItem {
  milestone: string;
  message: string;
  createdAt: string;
}

export interface EvidenceView {
  kind: string;
  excerpt: string;
  location?: string;
}

export interface FindingView {
  id: string;
  title: string;
  status: "confirmed" | "rubric_concern" | "inconclusive";
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  description: string;
  scenarioId?: string;
  evidence: EvidenceView[];
  reproductions?: number;
  rerunOf?: string | null;
}

export interface PaymentView {
  id: string;
  amountCents: number;
  environment: Environment;
  kind: string;
  createdAt: string;
}

export interface JobDetail {
  job: JobSummary & { error?: string | null; retestOfJobId?: string | null };
  quotes: QuoteView[];
  messages: MessageView[];
  progress: ProgressItem[];
  findings: unknown[];
  payments: PaymentView[];
  report?: { summary: string; markdown?: string } | null;
}

export interface ProgressResponse {
  state: JobState;
  progress: ProgressItem[];
}

/** Server returns findings rows ({findingKey, data}) or flat findings; normalize both. */
export function normalizeFinding(raw: unknown): FindingView {
  const r = raw as Record<string, unknown>;
  const d = ((r.data as Record<string, unknown> | undefined) ?? r) as Record<string, unknown>;
  return {
    id: String(r.findingKey ?? d.id ?? r.id),
    title: String(d.title ?? "Finding"),
    status: (d.status as FindingView["status"]) ?? "inconclusive",
    severity: (d.severity as FindingView["severity"]) ?? "low",
    category: String(d.category ?? "other"),
    description: String(d.description ?? ""),
    scenarioId: d.scenarioId as string | undefined,
    evidence: Array.isArray(d.evidence) ? (d.evidence as EvidenceView[]) : [],
    reproductions: d.reproductions as number | undefined,
    rerunOf: (r.rerunOfFindingId as string | null | undefined) ?? null,
  };
}

export interface OperatorOverview {
  revenue?: { liveCents?: number; testCents?: number };
  knownCosts?: { naiveMicroUsd?: number; aiGatewayMicroUsd?: number };
  unknownCosts?: string[];
  jobs?: Array<{
    id: string; customerEmail?: string; package: Package; state: JobState;
    environment: Environment; revenueCents?: number; knownCostMicroUsd?: number;
  }>;
  payments?: Array<{
    id: string; jobId?: string; amountCents: number; environment: Environment;
    kind?: string; createdAt: string;
  }>;
  decisions?: Array<{
    id: string; jobId?: string | null; agent: string; decision?: string | null;
    status?: string; usageMicroUsd?: number; createdAt: string;
  }>;
  interventions?: Array<{
    id: string; jobId?: string | null; operatorEmail?: string; kind: string; note: string; createdAt: string;
  }>;
  outreach?: Array<{
    id: string; toEmail: string; subject: string; body: string; status: string; createdAt?: string;
  }>;
}
