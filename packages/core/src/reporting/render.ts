/**
 * Report artifacts: JSON (machine-readable), Markdown, and optional HTML.
 * Customer/agent text is untrusted: Markdown neutralizes formatting and puts quotes in fenced blocks;
 * HTML escapes everything. Reports carry known costs and name unknown costs; they never show
 * revenue or profit.
 */
import type { OperatorSummary } from "../agents/operator";
import { PRICE_TABLE, priceLabel } from "../evals/pricing";
import { type CostEntry, type Finding, type FindingLabel, formatUsd, type JobRef, type MicroUsd } from "../evals/types";

export interface ReportInput {
  job: JobRef;
  generatedAt: string;
  findings: Finding[];
  limitations: string[];
  operatorSummary: OperatorSummary | null;
  /** Measured Naïve session costs for this job; null when the caller cannot supply the full list. */
  costs: CostEntry[] | null;
  /** AI Gateway judge calls: token counts only (monetary cost unknown). */
  judgeUsage?: { calls: number; promptTokens: number | null; completionTokens: number | null } | null;
  /** Extra structured payload to embed in the JSON export (e.g. trace claims, suite reference). */
  details?: Record<string, unknown>;
  includeMonitoringPitch?: boolean;
  includeHtml?: boolean;
  /** Supplied by execution, never inferred from an empty findings list. */
  evaluationStatus?: 'completed' | 'unresolved' | 'needs_operator';
}

export interface ReportJson {
  schemaVersion: "report.v1";
  generatedAt: string;
  job: { jobId: string; package: string; environment: string; isFixture: boolean; linkedRetestOf: string | null };
  package: { name: string; price: string };
  summary: { text: string; authorship: "agent_written" | "generated_from_findings"; counts: Record<FindingLabel, number> };
  findings: Finding[];
  operatorNotes: Array<{ findingId: string; note: string }>;
  nextSteps: string[];
  limitations: string[];
  costs: { knownMicroUsd: MicroUsd | null; entries: CostEntry[]; unknown: string[] };
  monitoringPitch: string | null;
  details: Record<string, unknown>;
  evaluationStatus: ReportInput['evaluationStatus'] | null;
}

export interface RenderedReport {
  json: ReportJson;
  markdown: string;
  html: string | null;
  summary: string;
  monitoringPitch: string | null;
}

const LABEL_TEXT: Record<FindingLabel, string> = {
  confirmed: "Confirmed",
  rubric_concern: "Rubric concern",
  inconclusive: "Inconclusive",
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Inline Markdown text: no links, images, HTML, emphasis, headings or tables can be injected. */
export function mdText(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/([\\`*_{}[\]()#+!|~>-])/g, "\\$1").replace(/</g, "&lt;");
}

/** A fenced block that cannot be closed early by the content. */
export function mdFence(s: string): string {
  const longest = Math.max(2, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${s}\n${fence}`;
}

function counts(findings: Finding[]): Record<FindingLabel, number> {
  const c: Record<FindingLabel, number> = { confirmed: 0, rubric_concern: 0, inconclusive: 0 };
  for (const f of findings) c[f.label] += 1;
  return c;
}

function generatedSummary(findings: Finding[]): string {
  if (findings.length === 0) return "No problems were found in what was examined. See the limitations for what this does not cover.";
  const c = counts(findings);
  return `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${c.confirmed} confirmed, ${c.rubric_concern} rubric concern${c.rubric_concern === 1 ? "" : "s"}, ${c.inconclusive} inconclusive.`;
}

const MONITORING = PRICE_TABLE.monitoring_pilot;
const monitoringPitch = () =>
  `Want this re-checked automatically? The ${MONITORING.name} re-runs your frozen suite nightly and emails you when a result regresses: ${priceLabel(MONITORING)}.`;

export function renderReport(input: ReportInput): RenderedReport {
  const offer = PRICE_TABLE[input.job.package];
  const knownMicroUsd = input.costs ? input.costs.reduce((s, c) => s + c.microUsd, 0) : null;
  const unknown = ["Your own model-provider usage during the evaluation", "Hosting and infrastructure"];
  if (input.judgeUsage && input.judgeUsage.calls > 0) unknown.push(`AI Gateway judge calls (${input.judgeUsage.calls}; token counts recorded, monetary cost not reported)`);

  const incomplete = input.evaluationStatus && input.evaluationStatus !== 'completed';
  const summaryText = incomplete
    ? `${input.evaluationStatus === 'needs_operator' ? 'Operator reconciliation required' : 'Evaluation incomplete'}. ${input.findings.length ? generatedSummary(input.findings) : 'No product conclusion is available.'}`
    : input.operatorSummary?.executive_summary ?? generatedSummary(input.findings);
  const pitch = input.includeMonitoringPitch ? monitoringPitch() : null;

  const json: ReportJson = {
    schemaVersion: "report.v1",
    generatedAt: input.generatedAt,
    job: { jobId: input.job.jobId, package: input.job.package, environment: input.job.environment, isFixture: input.job.isFixture, linkedRetestOf: input.job.linkedRetestOf },
    package: { name: offer.name, price: priceLabel(offer) },
    summary: { text: summaryText, authorship: input.operatorSummary && !incomplete ? "agent_written" : "generated_from_findings", counts: counts(input.findings) },
    findings: input.findings,
    operatorNotes: (input.operatorSummary?.finding_notes ?? []).map((n) => ({ findingId: n.finding_id, note: n.note })),
    nextSteps: input.operatorSummary?.recommended_next_steps ?? [],
    limitations: input.limitations,
    costs: { knownMicroUsd, entries: structuredClone(input.costs ?? []), unknown },
    monitoringPitch: pitch,
    details: input.details ?? {},
    evaluationStatus: input.evaluationStatus ?? null,
  };

  const notes = new Map(json.operatorNotes.map((n) => [n.findingId, n.note]));
  const md: string[] = [];
  md.push(`# ${mdText(offer.name)} report`);
  if (input.job.isFixture) md.push("", "> **Internal fixture job.** Not a customer result.");
  if (input.job.environment === "test") md.push("", "> Test-mode job.");
  md.push("", `Job \`${input.job.jobId}\` · generated ${mdText(input.generatedAt)} · ${mdText(priceLabel(offer))}`);
  md.push("", "## Summary", "", mdText(summaryText));
  if (input.operatorSummary && !incomplete) md.push("", "_Summary written by our operator agent from the findings below._");
  md.push("", `| Confirmed | Rubric concern | Inconclusive |`, `|---|---|---|`, `| ${json.summary.counts.confirmed} | ${json.summary.counts.rubric_concern} | ${json.summary.counts.inconclusive} |`);

  md.push("", "## Findings");
  if (input.findings.length === 0) md.push("", "No findings.");
  for (const f of input.findings) {
    md.push("", `### ${f.id} · ${LABEL_TEXT[f.label]} · ${f.severity} — ${mdText(f.title)}`);
    md.push("", `Category: ${mdText(f.category)}${f.basis === "unspecified" ? "" : ` · Basis: ${f.basis}`}`, "", mdText(f.summary));
    const note = notes.get(f.id);
    if (note) md.push("", `Operator note: ${mdText(note)}`);
    if (f.investigatorNote) md.push("", `Investigator: ${mdText(f.investigatorNote)}`);
    md.push("", "Evidence:");
    for (const e of f.evidence) {
      if (e.kind === "check") md.push("", `- Check ${mdText(e.checkId)}: ${mdText(e.detail)}`);
      else {
        const where = e.kind === "legacy_excerpt" ? `Legacy location: ${e.location || "unspecified"}` : e.kind === "trace_event" ? `log event ${e.eventId}` : `scenario ${e.scenarioId}, run ${e.runId}`;
        md.push("", `- ${mdText(where)}${e.truncated ? " (excerpt)" : ""}:`, "", mdFence(e.quote));
      }
    }
  }
  if (json.nextSteps.length) md.push("", "## Recommended next steps", "", ...json.nextSteps.map((s) => `- ${mdText(s)}`));
  md.push("", "## Limitations", "", ...input.limitations.map((l) => `- ${mdText(l)}`));
  md.push(
    "",
    "## Costs",
    "",
    knownMicroUsd === null
      ? "Known costs are tracked per job in the operator console."
      : `Known costs for this job: ${formatUsd(knownMicroUsd)} (agent sessions, measured by the provider).`,
    "",
    "Not included (unknown):",
    ...unknown.map((u) => `- ${mdText(u)}`),
  );
  if (pitch) md.push("", "## Monitoring", "", mdText(pitch));
  const markdown = `${md.join("\n")}\n`;

  return { json, markdown, html: input.includeHtml ? renderHtml(json, LABEL_TEXT, notes) : null, summary: summaryText, monitoringPitch: pitch };
}

function renderHtml(r: ReportJson, labels: Record<FindingLabel, string>, notes: Map<string, string>): string {
  const h = escapeHtml;
  const findings = r.findings
    .map((f) => {
      const ev = f.evidence
        .map((e) =>
          e.kind === "check"
            ? `<li>Check ${h(e.checkId)}: ${h(e.detail)}</li>`
            : `<li>${h(e.kind === "legacy_excerpt" ? `Legacy location: ${e.location || "unspecified"}` : e.kind === "trace_event" ? `log event ${e.eventId}` : `scenario ${e.scenarioId}, run ${e.runId}`)}${e.truncated ? " (excerpt)" : ""}<pre><code>${h(e.quote)}</code></pre></li>`,
        )
        .join("");
      const note = notes.get(f.id);
      return `<section class="finding" data-label="${h(f.label)}"><h3>${h(f.id)} · ${h(labels[f.label])} · ${h(f.severity)} — ${h(f.title)}</h3><p>Category: ${h(f.category)}${f.basis === "unspecified" ? "" : ` · Basis: ${h(f.basis)}`}</p><p>${h(f.summary)}</p>${note ? `<p>Operator note: ${h(note)}</p>` : ""}${f.investigatorNote ? `<p>Investigator: ${h(f.investigatorNote)}</p>` : ""}<ul>${ev}</ul></section>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${h(r.package.name)} report</title></head><body><article>
<h1>${h(r.package.name)} report</h1>${r.job.isFixture ? "<p><strong>Internal fixture job.</strong> Not a customer result.</p>" : ""}
<p>Job ${h(r.job.jobId)} · ${h(r.generatedAt)} · ${h(r.package.price)}</p>
<h2>Summary</h2><p>${h(r.summary.text)}</p>
<h2>Findings</h2>${findings || "<p>No findings.</p>"}
<h2>Limitations</h2><ul>${r.limitations.map((l) => `<li>${h(l)}</li>`).join("")}</ul>
<h2>Costs</h2><p>${r.costs.knownMicroUsd === null ? "Known costs are tracked per job in the operator console." : `Known costs for this job: ${h(formatUsd(r.costs.knownMicroUsd))}`}</p><ul>${r.costs.unknown.map((u) => `<li>Not included: ${h(u)}</li>`).join("")}</ul>
${r.monitoringPitch ? `<h2>Monitoring</h2><p>${h(r.monitoringPitch)}</p>` : ""}
</article></body></html>`;
}
