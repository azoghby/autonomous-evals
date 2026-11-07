import { describe, expect, it } from "vitest";
import { Finding, PER_FINDING_CAP_CENTS, PER_FINDING_CENTS, PRICE_CENTS, Remediation, Suite, perFindingCaptureCents } from "@ae/core/contracts/index";
import { sampleBundle, sampleFindings, sampleRemediations, sampleSuite } from "./sample-report";

describe("sample report fixture", () => {
  it("findings conform to the Finding contract with the expected mix", () => {
    const parsed = sampleFindings.map((f) => Finding.parse(f));
    expect(parsed.map((f) => [f.severity, f.category, f.status])).toEqual([
      ["critical", "unsupported_claim", "confirmed"],
      ["high", "ignored_error", "confirmed"],
      ["medium", "instruction_violation", "rubric_concern"],
      ["low", "factual", "inconclusive"],
    ]);
  });

  it("remediations conform, reference confirmed findings, and are 0/3 -> 3/3 with no regressions", () => {
    const confirmed = new Set(sampleFindings.filter((f) => f.status === "confirmed").map((f) => f.id));
    expect(sampleRemediations).toHaveLength(2);
    for (const r of sampleRemediations.map((x) => Remediation.parse(x))) {
      expect(confirmed.has(r.findingId)).toBe(true);
      expect(r.verification).toMatchObject({ status: "verified", before: { passed: 0, total: 3 }, after: { passed: 3, total: 3 }, regressions: 0 });
    }
    expect(sampleRemediations.map((r) => r.kind).sort()).toEqual(["guardrail", "prompt_patch"]);
  });

  it("suite conforms to the Suite contract", () => {
    expect(() => Suite.parse(sampleSuite)).not.toThrow();
  });

  it("pricing shown on the page matches the contract constants", () => {
    const confirmed = sampleFindings.filter((f) => f.status === "confirmed").length;
    expect(PRICE_CENTS.trace_audit).toBe(500);
    expect(perFindingCaptureCents(confirmed, PER_FINDING_CAP_CENTS.trace_audit)).toBe(confirmed * PER_FINDING_CENTS);
    expect(confirmed * PER_FINDING_CENTS).toBe(600);
  });

  it("bundle is JSON-serialisable and flagged as a sample", () => {
    const round = JSON.parse(JSON.stringify(sampleBundle));
    expect(round.sample).toBe(true);
  });
});
