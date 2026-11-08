import { describe, expect, it } from "vitest";
import { evaluateRegression, redactSecret, targetKeyFromHeader } from "./regression-check";

const scenarios = [{ id: "s1", title: "Refund flow" }, { id: "s2", title: "Escalation" }, { id: "s3", title: "Tone" }];
const findings = [{ data: { id: "F-1", scenarioId: "s1" } }, { data: { id: "F-2", scenarioId: "s2" } }, { data: { id: "F-3" } }];
const remediations = [
  { id: "r1", findingId: "F-1", verification: { status: "verified" } },
  { id: "r2", findingId: "F-2", verification: { status: "not_verified" } },
  { id: "r3", findingId: "F-3", verification: { status: "verified" } },
];
const res = (scenarioId: string, passed: boolean, detail = "d") => ({ scenarioId, passed, detail });

describe("evaluateRegression", () => {
  it("counts passes and lists failures with titles", () => {
    const v = evaluateRegression({ scenarios, findings, remediations, results: [res("s1", true), res("s2", false, "bad"), res("s3", true)] });
    expect(v.passed).toBe(2);
    expect(v.total).toBe(3);
    expect(v.failed).toEqual([{ scenarioId: "s2", title: "Escalation", detail: "bad" }]);
  });
  it("flags only failing scenarios tied to verified remediations", () => {
    const v = evaluateRegression({ scenarios, findings, remediations, results: [res("s1", false), res("s2", false), res("s3", false)] });
    expect(v.failed).toHaveLength(3);
    expect(v.previouslyFixedRegressed).toEqual([expect.objectContaining({ scenarioId: "s1", findingId: "F-1", remediationId: "r1" })]);
  });
  it("returns nothing failing when everything passes", () => {
    const v = evaluateRegression({ scenarios, findings, remediations, results: [res("s1", true)] });
    expect(v.failed).toEqual([]);
    expect(v.previouslyFixedRegressed).toEqual([]);
  });
  it("falls back to the scenario id as title and truncates long detail", () => {
    const v = evaluateRegression({ scenarios: [], findings: [], remediations: [], results: [res("x", false, "y".repeat(1000))] });
    expect(v.failed[0].title).toBe("x");
    expect(v.failed[0].detail.length).toBeLessThanOrEqual(300);
  });
});

describe("secret handling", () => {
  it("strips Bearer from the header value", () => {
    expect(targetKeyFromHeader("Bearer sk-abc")).toBe("sk-abc");
    expect(targetKeyFromHeader("sk-abc")).toBe("sk-abc");
    expect(targetKeyFromHeader("  ")).toBeUndefined();
    expect(targetKeyFromHeader(null)).toBeUndefined();
  });
  it("redacts the secret in raw and bearer-less form", () => {
    expect(redactSecret("401 for Bearer sk-secret-1 and sk-secret-1", "Bearer sk-secret-1")).not.toContain("sk-secret-1");
    expect(redactSecret("nothing", undefined)).toBe("nothing");
  });
});
