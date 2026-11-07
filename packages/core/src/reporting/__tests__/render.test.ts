// FIXTURE tests for report artifacts.
import { describe, expect, it } from "vitest";
import { fixtureJob } from "../../agents/__tests__/fakes";
import type { Finding } from "../../evals/types";
import { escapeHtml, mdFence, renderReport } from "../render";

const evil: Finding = {
  id: "F1",
  source: "trace_audit",
  category: "unsupported_claim",
  title: "<img src=x onerror=alert(1)> [click](javascript:alert(1))",
  label: "confirmed",
  severity: "high",
  basis: "objective",
  summary: "# heading\n| table | injection |",
  evidence: [{ kind: "trace_event", eventId: "e2", quote: "```\n</code></pre><script>alert(1)</script>", truncated: false }],
  investigatorNote: "<b>bold</b>",
  reproduction: null,
};

describe("renderReport", () => {
  it('does not call an empty unresolved evaluation clean, even if an operator summary does', () => {
    const report = renderReport({ job: fixtureJob(), generatedAt: '2026-11-07T21:00:00Z', findings: [],
      limitations: ['Execution unavailable.'], costs: null, evaluationStatus: 'unresolved',
      operatorSummary: { executive_summary: 'Everything passed.', finding_notes: [], recommended_next_steps: [], retest_recommended: false, authorship: 'agent_written' },
      includeHtml: true });
    expect(report.summary).toBe('Evaluation incomplete. No product conclusion is available.');
    expect(report.json.evaluationStatus).toBe('unresolved');
    expect(report.json.summary.authorship).toBe('generated_from_findings');
    expect(report.markdown).not.toContain('Everything passed');
    expect(report.html).not.toContain('Everything passed');
  });
  const r = renderReport({
    job: fixtureJob(),
    generatedAt: "2026-11-07T21:00:00.000Z",
    findings: [evil],
    limitations: ["Only the supplied log was examined."],
    operatorSummary: null,
    costs: [{ jobId: "job-fixture-1", source: "naive_session", role: "quality_investigator", externalId: "ses_x", purpose: "trace_recheck", microUsd: 123_456, measured: true, recordedAt: "t" }],
    judgeUsage: { calls: 2, promptTokens: 100, completionTokens: 20 },
    includeMonitoringPitch: true,
    includeHtml: true,
  });

  it("escapes all untrusted text in HTML", () => {
    expect(r.html).not.toMatch(/<script>|<img|<b>bold/);
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("neutralizes Markdown injection and keeps quotes inside a fence that cannot be closed", () => {
    expect(r.markdown).not.toContain("<img");
    expect(r.markdown).not.toMatch(/\[click\]\(javascript/);
    expect(r.markdown).toContain("````text\n```\n</code></pre><script>");
    expect(mdFence("a ```` b")).toMatch(/^`{5}text/);
  });

  it("reports known costs, names unknown costs, and never shows revenue or profit", () => {
    expect(r.json.costs.knownMicroUsd).toBe(123_456);
    expect(r.markdown).toContain("Known costs for this job: $0.12");
    expect(r.json.costs.unknown.join(" ")).toMatch(/model-provider usage.*|Hosting/);
    expect(r.json.costs.unknown.join(" ")).toMatch(/AI Gateway judge calls \(2/);
    expect(`${r.markdown}${r.html}${JSON.stringify(r.json)}`).not.toMatch(/profit|revenue/i);
  });

  it("labels fixture jobs, uses fixed prices, and produces valid JSON", () => {
    expect(r.markdown).toContain("Internal fixture job");
    expect(r.json.package.price).toBe("$5 (pilot pricing)");
    expect(r.monitoringPitch).toContain("$49/month (pilot pricing)");
    expect(JSON.parse(JSON.stringify(r.json)).schemaVersion).toBe("report.v1");
    expect(r.json.summary.authorship).toBe("generated_from_findings");
  });

  it("says costs are tracked elsewhere when the caller cannot supply them", () => {
    const r2 = renderReport({ job: fixtureJob(), generatedAt: "t", findings: [], limitations: [], operatorSummary: null, costs: null });
    expect(r2.json.costs.knownMicroUsd).toBeNull();
    expect(r2.markdown).toContain("No problems were found in what was examined");
    expect(r2.html).toBeNull();
  });

  it("escapeHtml covers quotes", () => expect(escapeHtml(`"'&`)).toBe("&quot;&#39;&amp;"));
});
