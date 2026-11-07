// Local fake-runner regressions: no provider calls.
import { describe, expect, it } from "vitest";
import type { Finding } from "../../evals/types";
import { writeReportSummary, type ReportSummaryOutput } from "../operator";
import { fixtureJob, harness } from "./fakes";

const finding = (id: string, label: Finding["label"]): Finding => ({
  id, label, source: "trace_audit", category: "unsupported_claim", title: "Booking claim",
  severity: "medium", basis: "objective", summary: "Booking evidence", evidence: [], investigatorNote: null, reproduction: null,
});
const run = async (findings: Finding[], output: Partial<ReportSummaryOutput>) => {
  const h = harness(() => ({ structuredOutput: {
    executive_summary: "The available evidence is inconclusive.", finding_notes: [], recommended_next_steps: [], retest_recommended: false,
    ...output,
  } }));
  return writeReportSummary({ job: fixtureJob(), findings, limitations: ["Only the supplied trace was examined."] }, h.service);
};

describe("operator labels (D9)", () => {
  it.each(["inconclusive", "rubric_concern"] as const)("rejects affirmative summary claims for %s findings", async (label) => {
    const out = await run([finding("F1", label)], { executive_summary: "We confirmed the booking failure." });
    expect(out).toMatchObject({ status: "failed", code: "summary_policy_violation", cost: expect.any(Object) });
  });

  it("rejects confirmation when there are no findings", async () => {
    expect(await run([], { executive_summary: "Confirmed failure." })).toMatchObject({ status: "failed", code: "summary_policy_violation" });
  });

  it.each(["inconclusive", "rubric_concern"] as const)("checks each %s note even with a confirmed finding elsewhere", async (label) => {
    expect(await run([finding("F1", "confirmed"), finding("F2", label)], {
      executive_summary: "One confirmed finding, F1.", finding_notes: [{ finding_id: "F2", note: "Confirmed booking failure." }],
    })).toMatchObject({ status: "failed", code: "summary_policy_violation" });
  });

  it("rejects an explicit contradictory summary in a mixed report", async () => {
    expect(await run([finding("F1", "confirmed"), finding("F2", "inconclusive")], {
      executive_summary: "F2 is confirmed.",
    })).toMatchObject({ status: "failed", code: "summary_policy_violation" });
  });

  it("checks every member of a coordinated confirmed subject list", async () => {
    expect(await run([finding("F1", "confirmed"), finding("F2", "inconclusive")], {
      executive_summary: "F2 and F1 are confirmed.",
    })).toMatchObject({ status: "failed", code: "summary_policy_violation" });
  });

  it("checks next steps for unsupported confirmation", async () => {
    expect(await run([finding("F1", "inconclusive")], { recommended_next_steps: ["Repair the confirmed failure."] }))
      .toMatchObject({ status: "failed", code: "summary_policy_violation" });
  });

  it.each(["not confirmed", "not yet confirmed", "has not been confirmed", "cannot be confirmed", "could not be confirmed", "unconfirmed", "No confirmed findings", "0 confirmed findings"])("allows limitation wording: %s", async (text) => {
    const out = await run([finding("F1", "inconclusive")], {
      executive_summary: `F1: ${text}. Only the supplied trace was examined.`,
      finding_notes: [{ finding_id: "F1", note: text }], recommended_next_steps: [`Review evidence: ${text}.`],
    });
    expect(out).toMatchObject({ status: "completed", value: { authorship: "agent_written" } });
    if (out.status === "completed") expect(out.value.executive_summary).toContain("Only the supplied trace was examined.");
  });

  it("does not let a preceding negative hide a later affirmative claim", async () => {
    expect(await run([finding("F1", "inconclusive")], { executive_summary: "Not confirmed initially, but now confirmed." }))
      .toMatchObject({ status: "failed", code: "summary_policy_violation" });
    expect(await run([finding("F1", "inconclusive")], { executive_summary: "Not only confirmed, but reproducible." }))
      .toMatchObject({ status: "failed", code: "summary_policy_violation" });
  });

  it("accepts grounded confirmed statements alongside inconclusive labels", async () => {
    expect(await run([finding("F1", "confirmed"), finding("F2", "inconclusive")], {
      executive_summary: "F1 is confirmed, while F2 is not confirmed. Only the supplied trace was examined.",
      finding_notes: [{ finding_id: "F1", note: "Confirmed failure." }, { finding_id: "F2", note: "Not confirmed." }],
    })).toMatchObject({ status: "completed" });
  });
});
