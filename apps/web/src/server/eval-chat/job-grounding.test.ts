import { describe, expect, it } from "vitest";
import { GroundingError } from "./grounding";
import { findFinding, findingEvidence, jobContext, jobFindings, jobSuggestions, jobSummary } from "./job-grounding";
import { makeJobInput } from "./fixtures.testing";

describe("jobSummary", () => {
  it("counts findings by severity and flags delivery", () => {
    const s = jobSummary(makeJobInput());
    expect(s).toMatchObject({ state: "delivered", delivered: true, remediations: 1, reportSummary: "Two findings.", bySeverity: { critical: 1, high: 0, medium: 0, low: 1 } });
    expect(s.findings.map((f) => f.title)).toEqual(["Leaks customer email", "Slow reply"]);
    expect(s.createdAt).toBe("2026-06-01T00:00:00.000Z");
  });
  it("is not delivered before the delivered state and tolerates a missing report", () => {
    const d = makeJobInput({ state: "running" });
    d.report = null;
    expect(jobSummary(d)).toMatchObject({ delivered: false, reportSummary: null });
  });
});

describe("findFinding", () => {
  const data = makeJobInput();
  it("finds by row id, contract key, and partial title", () => {
    expect(findFinding(data, "f-row-1").key).toBe("F1");
    expect(findFinding(data, "F2").id).toBe("f-row-2");
    expect(findFinding(data, "customer EMAIL").id).toBe("f-row-1");
  });
  it("throws a GroundingError listing valid ids for unknown findings", () => {
    expect(() => findFinding(data, "nope")).toThrow(GroundingError);
    expect(() => findFinding(data, "nope")).toThrow(/f-row-1, f-row-2/);
  });
  it("says there are none when the audit has no findings yet", () => {
    expect(() => findFinding({ ...data, findings: [] }, "x")).toThrow(/\(none yet\)/);
  });
});

describe("findingEvidence", () => {
  it("attaches the remediation and labels evidence with its location", () => {
    const c = findingEvidence(makeJobInput(), "F1");
    expect(c).toMatchObject({ findingId: "f-row-1", severity: "critical", status: "confirmed", reproductions: 3 });
    expect(c.evidence).toEqual([{ label: "trace · turn 4", text: "email is ann@example.com" }]);
    expect(c.remediation).toEqual({ title: "prompt patch", summary: "Never print emails", patch: "+ Never print emails" });
  });
  it("has no remediation for a finding without one", () => {
    expect(findingEvidence(makeJobInput(), "F2")).toMatchObject({ remediation: null, evidence: [], reproductions: null });
  });
});

describe("jobContext / jobFindings", () => {
  it("is parseable JSON without the report markdown", () => {
    const d = makeJobInput();
    d.report = { summary: "S", markdown: "SECRET-MARKDOWN-BODY" };
    const ctx = jobContext(d);
    expect(ctx).not.toContain("SECRET-MARKDOWN-BODY");
    expect(JSON.parse(ctx).findings).toHaveLength(2);
    expect(jobFindings(d)).toHaveLength(2);
  });
  it("is capped at 14000 characters", () => {
    const d = makeJobInput();
    d.findings = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, data: { id: `F${i}`, title: "t".repeat(300), severity: "low", status: "confirmed", category: "c", description: "d" } }));
    expect(jobContext(d).length).toBeLessThanOrEqual(14_000);
  });
});

describe("jobSuggestions", () => {
  it("is specific to the audit: names the most severe finding and offers a re-run when delivered", () => {
    const s = jobSuggestions(makeJobInput());
    expect(s[0]).toBe('Explain "Leaks customer email"');
    expect(s).toContain("Which fixes were verified?");
    expect(s.some((x) => x.startsWith('Re-run the "Leaks customer email"'))).toBe(true);
    expect(s.length).toBeLessThanOrEqual(5);
  });
  it("omits re-run suggestions before delivery and fix questions without remediations", () => {
    const d = makeJobInput({ state: "running" });
    d.remediations = [];
    const s = jobSuggestions(d);
    expect(s.some((x) => x.startsWith("Re-run"))).toBe(false);
    expect(s).not.toContain("Which fixes were verified?");
  });
});
