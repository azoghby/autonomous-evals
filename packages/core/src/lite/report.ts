import { Report, type Finding, type IntakeInput, type Remediation, type Suite } from "../contracts/index";
import type { EvalServices, ServiceContext } from "../contracts/services";

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Markdown-safe: neutralize raw script tags and code fences inside fenced excerpts. */
const mdSafe = (s: string): string => s.replace(/<\s*(\/?)\s*script/gi, "&lt;$1script").replace(/```/g, "'''");
const inlineMd = (s: string): string => mdSafe(s).replace(/\|/g, "\\|").replace(/\n+/g, " ");

const SEV_ORDER = ["critical", "high", "medium", "low"] as const;
const countBy = <K extends string>(items: Finding[], key: (f: Finding) => K): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const f of items) out[key(f)] = (out[key(f)] ?? 0) + 1;
  return out;
};
const fmtCounts = (c: Record<string, number>, order?: readonly string[]): string => {
  const keys = order ? order.filter((k) => c[k]) : Object.keys(c);
  return keys.length ? keys.map((k) => `${c[k]} ${k}`).join(", ") : "none";
};

const packageLabel = (intake: IntakeInput): string => {
  switch (intake.package) {
    case "trace_audit": return "Trace Audit";
    case "text_eval": return "Text Eval";
    case "workflow_eval": return "Workflow Eval";
    case "version_comparison": return `Version Comparison (${intake.mode})`;
  }
};

export function buildSummary(findings: Finding[]): string {
  if (findings.length === 0) return "No findings were reported.";
  const ranked = [...findings].sort((a, b) =>
    (a.status === "confirmed" ? 0 : 1) - (b.status === "confirmed" ? 0 : 1) || SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const top = ranked.slice(0, 3).map((f) => f.title).join("; ");
  return `${findings.length} finding(s). By status: ${fmtCounts(countBy(findings, (f) => f.status))}. By severity: ${fmtCounts(countBy(findings, (f) => f.severity), SEV_ORDER)}. Top: ${top}.`.slice(0, 9_000);
}

function remediationFor(rs: Remediation[], id: string): Remediation | undefined { return rs.find((r) => r.findingId === id); }

function buildMarkdown(intake: IntakeInput, findings: Finding[], suite: Suite | undefined, rs: Remediation[], summary: string): string {
  const L: string[] = [];
  L.push(`# Evaluation Report: ${packageLabel(intake)}`, "", "## Scope", "");
  L.push(`- Package: ${packageLabel(intake)}`);
  if (suite) L.push(`- Scenarios in frozen suite: ${suite.scenarios.length}`);
  if (intake.notes) L.push(`- Notes: ${inlineMd(intake.notes).slice(0, 500)}`);
  L.push("", "## Summary", "", mdSafe(summary), "", "## Findings", "");
  if (findings.length === 0) L.push("No findings.", "");
  else {
    L.push("| ID | Title | Status | Severity | Category |", "|---|---|---|---|---|");
    for (const f of findings) L.push(`| ${inlineMd(f.id)} | ${inlineMd(f.title)} | ${f.status} | ${f.severity} | ${f.category} |`);
    L.push("");
    for (const f of findings) {
      L.push(`### ${inlineMd(f.id)}: ${inlineMd(f.title)}`, "", `Status: ${f.status}. Severity: ${f.severity}. Category: ${f.category}.`, "", mdSafe(f.description), "");
      for (const e of f.evidence) L.push(`Evidence (${e.kind}${e.location ? `, ${inlineMd(e.location)}` : ""}):`, "", "```", mdSafe(e.excerpt), "```", "");
    }
  }
  if (rs.length) {
    L.push("## Remediations", "");
    for (const r of rs) {
      const v = r.verification;
      L.push(`### ${inlineMd(r.findingId)}: ${inlineMd(r.summary)}`, "",
        `Verification: ${v.status} (before ${v.before.passed}/${v.before.total}, after ${v.after.passed}/${v.after.total}, regressions ${v.regressions}).`, "",
        mdSafe(r.rationale), "", "```", mdSafe(r.patch), "```", "");
    }
  }
  return L.join("\n");
}

const STYLE = "font-family:system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;line-height:1.5";
const PRE = "background:#f4f4f5;padding:.75rem;border-radius:6px;overflow-x:auto;white-space:pre-wrap";

function buildHtml(intake: IntakeInput, findings: Finding[], suite: Suite | undefined, rs: Remediation[], summary: string): string {
  const e = escapeHtml;
  const parts: string[] = [];
  parts.push(`<h1>Evaluation Report: ${e(packageLabel(intake))}</h1>`, `<h2>Scope</h2><ul><li>Package: ${e(packageLabel(intake))}</li>`);
  if (suite) parts.push(`<li>Scenarios in frozen suite: ${suite.scenarios.length}</li>`);
  if (intake.notes) parts.push(`<li>Notes: ${e(intake.notes.slice(0, 500))}</li>`);
  parts.push("</ul>", `<h2>Summary</h2><p>${e(summary)}</p>`, "<h2>Findings</h2>");
  if (findings.length === 0) parts.push("<p>No findings.</p>");
  for (const f of findings) {
    parts.push(`<section style="border-left:4px solid #888;padding-left:1rem;margin:1.5rem 0"><h3>${e(f.id)}: ${e(f.title)}</h3>`,
      `<p><strong>${e(f.status)}</strong> / ${e(f.severity)} / ${e(f.category)}</p><p>${e(f.description)}</p>`);
    for (const ev of f.evidence) parts.push(`<p>Evidence (${e(ev.kind)}${ev.location ? `, ${e(ev.location)}` : ""}):</p><pre style="${PRE}">${e(ev.excerpt)}</pre>`);
    const r = remediationFor(rs, f.id);
    if (r) parts.push(`<p>Remediation: ${e(r.summary)} (verification: ${e(r.verification.status)})</p>`);
    parts.push("</section>");
  }
  if (rs.length) {
    parts.push("<h2>Remediations</h2>");
    for (const r of rs) {
      const v = r.verification;
      parts.push(`<h3>${e(r.findingId)}: ${e(r.summary)}</h3><p>Verification: ${e(v.status)} (before ${v.before.passed}/${v.before.total}, after ${v.after.passed}/${v.after.total}, regressions ${v.regressions})</p><p>${e(r.rationale)}</p><pre style="${PRE}">${e(r.patch)}</pre>`);
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Evaluation Report</title></head><body style="${STYLE}">${parts.join("\n")}</body></html>`;
}

export function createReportService(): EvalServices["renderReport"] {
  return async (ctx: ServiceContext, input) => {
    const findings = input.findings;
    const rs = input.remediations ?? [];
    const summary = buildSummary(findings);
    const confirmed = findings.filter((f) => f.status === "confirmed").length;
    return Report.parse({
      jobId: ctx.jobId,
      summary,
      markdown: buildMarkdown(input.intake, findings, input.suite, rs, summary),
      html: buildHtml(input.intake, findings, input.suite, rs, summary),
      findings,
      monitoringPitch: confirmed > 0
        ? "Failures like these can regress silently. Monthly monitoring re-runs this frozen suite nightly and alerts you on any new failure."
        : undefined,
    });
  };
}
