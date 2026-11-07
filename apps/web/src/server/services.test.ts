import { describe, expect, it } from "vitest";
import { Finding, Remediation } from "@ae/core/contracts/index";
import { mockServices } from "./services";

const finding = (category: Finding["category"]) => Finding.parse({
  id: "f1", title: "t", status: "confirmed", severity: "high", category, description: "d",
  evidence: [{ kind: "trace_excerpt", excerpt: "x" }],
});
const ctx = { jobId: "11111111-1111-4111-8111-111111111111", environment: "test", budgetMicroUsd: 1, recordCost: async () => {}, recordProgress: async () => {} } as const;
const intake = { package: "trace_audit", trace: "{}", authorizedToTest: true } as const;

describe("mock proposeAndVerifyFix", () => {
  it("is deterministic and schema-valid for every category", async () => {
    for (const c of ["unsupported_claim", "ignored_error", "instruction_violation", "unsafe_action", "factual", "state_mismatch", "false_success", "other"] as const) {
      const a = await mockServices.proposeAndVerifyFix(ctx, { finding: finding(c), intake });
      const b = await mockServices.proposeAndVerifyFix(ctx, { finding: finding(c), intake });
      expect(a).toEqual(b);
      expect(Remediation.safeParse(a).success).toBe(true);
      expect(a.findingId).toBe("f1");
    }
  });
  it("verifies an unsupported_claim prompt patch 0/1 -> 1/1", async () => {
    const r = await mockServices.proposeAndVerifyFix(ctx, { finding: finding("unsupported_claim"), intake });
    expect(r.kind).toBe("prompt_patch");
    expect(r.verification).toMatchObject({ status: "verified", before: { passed: 0, total: 1 }, after: { passed: 1, total: 1 } });
  });
  it("renders a Validated fixes section", async () => {
    const f = finding("unsupported_claim");
    const fix = await mockServices.proposeAndVerifyFix(ctx, { finding: f, intake });
    const rep = await mockServices.renderReport(ctx, { intake, findings: [f], remediations: [fix] });
    expect(rep.markdown).toContain("## Validated fixes");
    const none = await mockServices.renderReport(ctx, { intake, findings: [f] });
    expect(none.markdown).not.toContain("Validated fixes");
  });
});
