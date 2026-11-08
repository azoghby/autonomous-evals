// FIXTURE tests: Commercial and Operator policy enforcement with a fake Naïve API.
import { describe, expect, it } from "vitest";
import { findInventedPrices } from "../../evals/pricing";
import type { Finding } from "../../evals/types";
import { buildQuote, draftOutreach, type IntakeSummary, qualifyRequest } from "../commercial";
import { writeReportSummary } from "../operator";
import { fixtureJob, harness } from "./fakes";

const intake: IntakeSummary = { requestedPackage: "trace_audit", notes: "Please audit our booking bot", systemPromptExcerpt: null, trace: { bytes: 900, preview: "USER: book" }, endpointHost: null, clarifications: [] };

describe("pricing", () => {
  it("only menu prices pass", () => {
    expect(findInventedPrices("Trace Audit is $49, Text Eval $99, Workflow Eval $199, comparison $299, monitoring $49/month")).toEqual([]);
    expect(findInventedPrices("Old pilot quotes $5 and $10")).toEqual(["$5", "$10"]);
    expect(findInventedPrices("special price $3.50 or 20 dollars")).toEqual(["$3.50", "20dollars"]);
  });
  it("quotes come from the table and test mode never counts as revenue", () => {
    const q = buildQuote(fixtureJob({ environment: "test" }), "version_comparison", 1, "Compare two prompts; $1 discount");
    expect(q).toMatchObject({ priceMicroUsd: 299_000_000, priceCents: 29900, priceLabel: "$299", countsAsRevenue: false });
    expect(q.scopeSummary).not.toContain("$1");
    expect(buildQuote(fixtureJob({ environment: "live", isFixture: false }), "trace_audit", 1, "x").countsAsRevenue).toBe(true);
    expect(buildQuote(fixtureJob({ environment: "live", isFixture: true }), "trace_audit", 1, "x").countsAsRevenue).toBe(false);
  });
});

describe("qualifyRequest", () => {
  it("replaces agent text with invented prices and keeps deliverables from the table", async () => {
    const h = harness(() => ({ structuredOutput: { decision: "quote", recommended_package: "trace_audit", questions: ["Is $2 ok?"], scope_summary: "Audit for just $1!", decline_reason: null } }));
    const out = await qualifyRequest({ job: fixtureJob(), intake }, h.service);
    if (out.status !== "completed") throw new Error(out.status);
    expect(out.value.scopeSummary).not.toMatch(/\$1/);
    expect(out.value.questions).toEqual([]);
    expect(out.value.policyWarnings).toHaveLength(2);
    expect(out.value.deliverables[0]).toMatch(/success claim/);
  });

  it("reserves the plan's 30-cent default while preserving explicit lower authorized budgets", async () => {
    const make = () => harness(() => ({ structuredOutput: { decision: "quote", recommended_package: "trace_audit", questions: [], scope_summary: "Audit", decline_reason: null } }));
    const standard = make();
    await qualifyRequest({ job: fixtureJob(), intake }, standard.service);
    expect(standard.naive.createCalls[0]!.body.budget_micro_usd).toBe(300_000);
    const limited = make();
    await qualifyRequest({ job: fixtureJob(), intake, budgetMicroUsd: 100_000 }, limited.service);
    expect(limited.naive.createCalls[0]!.body.budget_micro_usd).toBe(100_000);
  });

  it("asks the customer when the agent recommends a different package", async () => {
    const h = harness(() => ({ structuredOutput: { decision: "quote", recommended_package: "text_eval", questions: [], scope_summary: "Endpoint eval", decline_reason: null } }));
    const out = await qualifyRequest({ job: fixtureJob(), intake }, h.service);
    if (out.status !== "completed") throw new Error(out.status);
    expect(out.value).toMatchObject({ decision: "clarify", package: "trace_audit" });
    expect(out.value.questions[0]).toMatch(/Text Eval may fit better/);
  });

  it("each clarification round is its own task; repeating a round reuses it", async () => {
    const h = harness(() => ({ structuredOutput: { decision: "clarify", recommended_package: "trace_audit", questions: ["Which tool logs?"], scope_summary: "s", decline_reason: null } }));
    await qualifyRequest({ job: fixtureJob(), intake }, h.service);
    await qualifyRequest({ job: fixtureJob(), intake }, h.service);
    await qualifyRequest({ job: fixtureJob(), intake: { ...intake, clarifications: ["calendar"] } }, h.service);
    expect(h.naive.createCalls.map((c) => c.body.metadata.ae_purpose)).toEqual(["qualify_r0", "qualify_r1"]);
  });

  it("never puts a known customer key into the prompt", async () => {
    const h = harness(() => ({ structuredOutput: { decision: "quote", recommended_package: "trace_audit", questions: [], scope_summary: "s", decline_reason: null } }));
    await qualifyRequest({ job: fixtureJob(), intake: { ...intake, notes: "our key: cust-key-123456" }, knownSecrets: ["cust-key-123456"] }, h.service);
    expect(h.naive.createCalls[0]!.body.message).not.toContain("cust-key-123456");
  });
});

describe("draftOutreach", () => {
  it("is always pending founder approval and rejects off-menu prices", async () => {
    const ok = harness(() => ({ structuredOutput: { subject: "Free first audit", body: "We audit agent logs. First one free, then $49." } }));
    const a = await draftOutreach({ prospectId: "team-1", teamName: "T", context: "c", environment: "test" }, ok.service);
    expect(a).toMatchObject({ status: "completed", value: { status: "pending_founder_approval" } });
    expect(ok.naive.createCalls[0]!.body.budget_micro_usd).toBe(300_000);
    const bad = harness(() => ({ structuredOutput: { subject: "Deal", body: "Only $1 today" } }));
    expect(await draftOutreach({ prospectId: "team-2", teamName: "T", context: "c", environment: "test" }, bad.service)).toMatchObject({ status: "failed", code: "invented_price" });
  });
});

describe("writeReportSummary", () => {
  const findings: Finding[] = [{ id: "F1", source: "trace_audit", category: "unsupported_claim", title: "t", label: "confirmed", severity: "high", basis: "objective", summary: "s", evidence: [{ kind: "check", checkId: "c", detail: "d" }], investigatorNote: null, reproduction: null }];
  it("rejects references to unknown findings and revenue/profit claims", async () => {
    const h = harness(() => ({ structuredOutput: { executive_summary: "Great profit ahead", finding_notes: [{ finding_id: "F9", note: "n" }], recommended_next_steps: [], retest_recommended: false } }));
    const out = await writeReportSummary({ job: fixtureJob(), findings, limitations: [] }, h.service);
    expect(out).toMatchObject({ status: "failed", code: "summary_policy_violation" });
    if (out.status === "failed") expect(out.message).toMatch(/unknown findings F9.*forbidden claim/);
  });
  it("accepts a grounded summary", async () => {
    const h = harness(() => ({ structuredOutput: { executive_summary: "One confirmed issue.", finding_notes: [{ finding_id: "F1", note: "Fix the claim." }], recommended_next_steps: ["Retest after fixing"], retest_recommended: true } }));
    expect(await writeReportSummary({ job: fixtureJob(), findings, limitations: [] }, h.service)).toMatchObject({ status: "completed", value: { authorship: "agent_written" } });
  });
});
