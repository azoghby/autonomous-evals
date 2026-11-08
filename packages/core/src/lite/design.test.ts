import { describe, expect, it, vi } from "vitest";
import { Finding, IntakeInput, QualifyResult, Report, Suite } from "../contracts/index";
import type { ServiceContext } from "../contracts/services";
import {
  CONFORMANCE_JOB_ID, TRACE_CLEAN_JSON, TRACE_SYSTEM_PROMPT, TRACE_UNSUPPORTED_CLAIM_JSON,
} from "../contracts/fixtures/index";
import { defaultLiteDeps, type LiteDeps } from "./deps";
import { createDesignServices } from "./design";

function makeCtx(budget = 3_000_000): ServiceContext & { costs: unknown[] } {
  const costs: unknown[] = [];
  return { jobId: CONFORMANCE_JOB_ID, environment: "test", budgetMicroUsd: budget, costs,
    async recordCost(e) { costs.push(e); }, async recordProgress() {} };
}

function fakeDeps(respond: (args: any) => unknown): { deps: LiteDeps; fn: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(async (args: any) => {
    const object = respond(args);
    await args.ctx.recordCost({ source: "ai_gateway", microUsd: 10, agent: args.agent, meta: {} });
    return { object, text: "", provider: "vercel", model: "x", inputTokens: 1, outputTokens: 1, microUsd: 10, costBasis: "list_price_estimate", latencyMs: 1 };
  });
  return { fn, deps: defaultLiteDeps({ generateStructured: fn as unknown as LiteDeps["generateStructured"], now: () => new Date("2026-11-07T00:00:00Z") }) };
}

const textIntake = (apiKey?: string) => IntakeInput.parse({
  package: "text_eval", authorizedToTest: true, notes: "Support bot",
  endpoint: { url: "https://target.example.com/v1/chat", model: "m", apiKey, systemPrompt: "Answer from reference.", referenceText: "Refunds within 30 days." },
});
const traceIntake = IntakeInput.parse({ package: "trace_audit", trace: TRACE_UNSUPPORTED_CLAIM_JSON, authorizedToTest: true });

describe("qualify", () => {
  it("strips prices, forces package, limits questions", async () => {
    const { deps, fn } = fakeDeps(() => ({
      decision: "quote", package: "workflow_eval", questions: ["How much? $5"],
      scopeSummary: "We will do it for $5 or 5 dollars total.", deliverables: ["Report (10 USD value)"],
    }));
    const out = await createDesignServices(deps).qualify(makeCtx(), textIntake("sk-secret-should-not-leak-0123456789"), []);
    QualifyResult.parse(out);
    expect(out.package).toBe("text_eval");
    expect(out.questions).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/\$\s?\d|\b\d+\s?(usd|dollars)\b/i);
    expect(JSON.stringify(fn.mock.calls[0][0])).not.toContain("sk-secret");
  });

  it("falls back to a template quote when the model throws", async () => {
    const { deps } = fakeDeps(() => { throw new Error("boom"); });
    const out = await createDesignServices(deps).qualify(makeCtx(), traceIntake, []);
    expect(out.decision).toBe("quote");
    expect(out.package).toBe("trace_audit");
    expect(out.deliverables.length).toBeGreaterThan(0);
  });

  it("makes no model call when budget is too low", async () => {
    const { deps, fn } = fakeDeps(() => ({}));
    await createDesignServices(deps).qualify(makeCtx(0), traceIntake, []);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("designSuite", () => {
  const good = (i: number) => ({ title: `T${i}`, category: "task_success", input: `in ${i}`, checks: [{ kind: "rubric", description: "must be right" }] });

  it("drops invalid, caps at 12, appends rt_*, schema-valid", async () => {
    const raw = [...Array.from({ length: 15 }, (_, i) => good(i)), "junk", { title: "bad" }];
    const { deps } = fakeDeps(() => ({ scenarios: raw }));
    const suite = await createDesignServices(deps).designSuite(makeCtx(), textIntake());
    Suite.parse(suite);
    const designed = suite.scenarios.filter((s) => !s.id.startsWith("rt_"));
    expect(designed).toHaveLength(12);
    expect(designed[0]!.id).toBe("s01");
    expect(designed[11]!.id).toBe("s12");
    expect(suite.scenarios.some((s) => s.id.startsWith("rt_"))).toBe(true);
    expect(suite.scenarios.length).toBeLessThanOrEqual(32);
    expect(suite.jobId).toBe(CONFORMANCE_JOB_ID);
  });

  it("falls back to templates on garbage output", async () => {
    const { deps } = fakeDeps(() => ({ scenarios: ["x", 5, null] }));
    const suite = await createDesignServices(deps).designSuite(makeCtx(), textIntake());
    Suite.parse(suite);
    expect(suite.scenarios.filter((s) => !s.id.startsWith("rt_")).length).toBeGreaterThanOrEqual(5);
  });

  it("returns a valid suite for trace_audit without calling the model", async () => {
    const { deps, fn } = fakeDeps(() => ({}));
    const suite = await createDesignServices(deps).designSuite(makeCtx(), traceIntake);
    Suite.parse(suite);
    expect(fn).not.toHaveBeenCalled();
    expect(suite.scenarios.length).toBeGreaterThan(0);
  });
});

describe("auditTrace", () => {
  it("deterministic pre-pass finds the unsupported claim with empty LLM output", async () => {
    const { deps } = fakeDeps(() => ({ findings: [], claimsChecked: 1 }));
    const out = await createDesignServices(deps).auditTrace(makeCtx(), TRACE_UNSUPPORTED_CLAIM_JSON, TRACE_SYSTEM_PROMPT);
    const hits = out.findings.filter((f) => f.status === "confirmed");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.category).toBe("unsupported_claim");
    expect(hits[0]!.evidence).toHaveLength(2);
    expect(hits[0]!.id).toBe("ta-f-01");
    out.findings.forEach((f) => Finding.parse(f));
  });

  it("works when the LLM call fails", async () => {
    const { deps } = fakeDeps(() => { throw new Error("down"); });
    const out = await createDesignServices(deps).auditTrace(makeCtx(), TRACE_UNSUPPORTED_CLAIM_JSON);
    expect(out.findings.some((f) => f.status === "confirmed")).toBe(true);
  });

  it("clean fixture yields zero confirmed findings", async () => {
    const { deps } = fakeDeps(() => ({ findings: [], claimsChecked: 1 }));
    const out = await createDesignServices(deps).auditTrace(makeCtx(), TRACE_CLEAN_JSON, TRACE_SYSTEM_PROMPT);
    expect(out.findings.filter((f) => f.status === "confirmed")).toHaveLength(0);
  });

  it("downgrades LLM excerpts missing from the trace and confirms present ones", async () => {
    const { deps } = fakeDeps(() => ({
      claimsChecked: 2,
      findings: [
        { category: "instruction_violation", title: "Made up", description: "d", severity: "medium", excerpt: "this text is not in the trace" },
        { category: "ignored_error", title: "Real", description: "d", severity: "medium", excerpt: "Done. I booked 'Sync with Dana' for tomorrow" },
        { category: "factual" as never, title: "bad category", description: "d", severity: "low", excerpt: "x" },
      ].slice(0, 2),
    }));
    const out = await createDesignServices(deps).auditTrace(makeCtx(), TRACE_CLEAN_JSON, TRACE_SYSTEM_PROMPT);
    expect(out.findings.find((f) => f.title === "Made up")!.status).toBe("rubric_concern");
    expect(out.findings.find((f) => f.title === "Real")!.status).toBe("confirmed");
  });
});

describe("renderReport", () => {
  it("escapes html in titles and evidence, schema-valid", async () => {
    const { deps } = fakeDeps(() => ({}));
    const svc = createDesignServices(deps);
    const evil = "<script>alert(1)</script>";
    const finding = Finding.parse({
      id: "f1", title: evil, status: "confirmed", severity: "high", category: "other",
      description: `desc ${evil}`, evidence: [{ kind: "response", excerpt: `x ${evil} "q" & 'a'` }],
    });
    const report = await svc.renderReport(makeCtx(), { intake: traceIntake, findings: [finding] });
    Report.parse(report);
    expect(report.html).not.toMatch(/<\s*script/i);
    expect(report.markdown).not.toMatch(/<\s*script/i);
    expect(report.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(report.markdown.length).toBeGreaterThan(0);
    expect(report.jobId).toBe(CONFORMANCE_JOB_ID);
  });
});
