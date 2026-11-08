import { beforeEach, describe, expect, it, vi } from "vitest";

const A_JOB = "11111111-1111-4111-8111-111111111111";
const B_JOB = "22222222-2222-4222-8222-222222222222";
const jobs: Record<string, { customerId: string; state: string }> = {
  [A_JOB]: { customerId: "A", state: "needs_clarification" },
  [B_JOB]: { customerId: "B", state: "needs_clarification" },
};
const FINDING_ROW = "44444444-4444-4444-8444-444444444444";
const quoteRow = { id: "q1", version: 2, package: "text_eval", priceCents: 9900, scopeSummary: "scope", deliverables: ["d"], acceptedAt: null, pricingMode: "fixed", capCents: null, stripeCheckoutSessionId: null };

const getJobForViewer = vi.fn(async (jobId: string, viewer: { id: string; isOperator: boolean }) => {
  const j = jobs[jobId];
  if (!j || (j.customerId !== viewer.id && !viewer.isOperator)) return null;
  return {
    job: { id: jobId, state: j.state, package: "text_eval", error: null },
    quotes: j.state === "quoted" ? [quoteRow] : [],
    messages: [{ role: "commercial", body: "Which tool failed?" }], progress: [],
    findings: [{ id: FINDING_ROW, rerunOfFindingId: null, data: { id: "F-1", title: "Bad claim", status: "confirmed", severity: "high", category: "unsupported_claim", description: "d", evidence: [{ kind: "judge", excerpt: "x".repeat(900) }] } }],
    payments: [{ status: "authorized", amountCents: 25000, capturedAmountCents: null }],
    remediations: [{ id: "r1", createdAt: new Date(), findingId: "F-1", kind: "prompt_patch", summary: "fix", patch: "p", rationale: "r", verification: { status: "verified" } }],
    report: { summary: "2 findings", markdown: "# Report" },
  };
});
const requestJobCancellation = vi.fn(async (jobId: string, viewer: { id: string; allowOperator?: boolean }, reason?: string) => {
  const job = jobs[jobId];
  if (!job || job.customerId !== viewer.id) return { ok: false, status: 404, error: "Job not found" };
  if (job.state === "running") return { ok: false, status: 409, error: "Work has already started", state: job.state };
  return { ok: true, request: { jobId, reason }, created: true };
});
const dispatchJobCancellation = vi.fn(async () => ({ jobId: A_JOB, errors: [] }));
vi.mock("./job-cancellation", () => ({ requestJobCancellation }));
vi.mock("./job-cancellation-delivery", () => ({ dispatchJobCancellation }));
const createJob = vi.fn(async () => ({ jobId: "33333333-3333-4333-8333-333333333333" }));
const sendJobEvent = vi.fn(async () => undefined);
const addMessage = vi.fn(async () => "m");
const expireOpenCheckout = vi.fn(async () => "expired");
const createCheckoutForQuote = vi.fn(async () => ({ sessionId: "cs_new", url: "https://checkout.stripe.test/cs_new" }));
const updateChain = { set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) };
const latestQuote = vi.fn(async (): Promise<typeof quoteRow | null> => quoteRow);

vi.mock("./queries", () => ({ getJobForViewer }));
vi.mock("./create-job", () => ({ createJob }));
vi.mock("./idempotency", () => ({
  IdempotencyInProgressError: class extends Error {},
  withIdempotency: async (_k: string, fn: () => Promise<{ status: number; body: unknown }>) => ({ ...(await fn()), replayed: false }),
}));
vi.mock("./job-actions", () => ({ submitClarificationAnswer: vi.fn(async () => ({ ok: true, value: { messageId: "m" } })), rerunFindingForJob: vi.fn(async () => ({ ok: true, value: { finding: {} } })) }));
vi.mock("./job-store", () => ({ latestQuote, addMessage }));
vi.mock("@/workflows/events", () => ({ sendJobEvent }));
vi.mock("@ae/core/payments/checkout", () => ({ createCheckoutForQuote, expireOpenCheckout }));
vi.mock("@ae/core/payments/stripe", () => ({ stripe: () => ({ checkout: { sessions: { retrieve: vi.fn(), expire: vi.fn() } } }) }));
vi.mock("@ae/core/db/client", () => ({ db: () => ({ update: () => updateChain }), schema: { quotes: { id: "id", stripeCheckoutSessionId: "s", acceptedAt: "a" } } }));

const { TOOLS, getJob, getReport, answerClarification, acceptQuote, cancelJob, requestEval, listPackages, sampleReportMarkdown } = await import("./mcp-tools");

const A = { customerId: "A", email: "a@x.com", origin: "https://x.test" };
const B = { customerId: "B", email: "b@x.com", origin: "https://x.test" };

beforeEach(() => {
  vi.clearAllMocks();
  jobs[A_JOB].state = "needs_clarification";
  latestQuote.mockResolvedValue(quoteRow);
});

describe("MCP tool ownership", () => {
  it("owner can read their job", async () => {
    const r = await getJob(A, A_JOB);
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent?.pendingClarificationQuestions).toEqual(["Which tool failed?"]);
  });
  it("key A cannot read, answer, accept, cancel or report on customer B's job (looks like not found)", async () => {
    for (const r of [await getJob(A, B_JOB), await answerClarification(A, B_JOB, "x"), await acceptQuote(A, B_JOB, 1), await getReport(A, B_JOB), await cancelJob(A, B_JOB)]) {
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Job not found");
    }
    expect(sendJobEvent).not.toHaveBeenCalled();
    expect(createCheckoutForQuote).not.toHaveBeenCalled();
  });
  it("never grants operator powers even if the owner's email is an operator", async () => {
    await getJob(B, A_JOB);
    expect(getJobForViewer.mock.calls[0][1]).toMatchObject({ id: "B", isOperator: false });
  });
});

describe("MCP tool validation", () => {
  it("create_job rejects a package missing its inputs without creating a job", async () => {
    const r = await requestEval(A, { package: "text_eval", authorizedToTest: true, idempotencyKey: "k" });
    expect(r.isError).toBe(true);
    expect(createJob).not.toHaveBeenCalled();
  });
  it("create_job creates a job for a valid trace_audit", async () => {
    const r = await requestEval(A, { package: "trace_audit", trace: "user: hi", authorizedToTest: true, idempotencyKey: "k" });
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ customerId: "A", idempotencyKey: "k" }));
    expect(r.structuredContent?.jobUrl).toBe("https://x.test/jobs/33333333-3333-4333-8333-333333333333");
  });
  it("input schemas reject non-uuid job ids, authorizedToTest=false and unknown pricing modes", () => {
    expect(TOOLS.find((t) => t.name === "get_job")!.inputSchema.safeParse({ jobId: "nope" }).success).toBe(false);
    expect(TOOLS.find((t) => t.name === "create_job")!.inputSchema.safeParse({ package: "trace_audit", trace: "x", authorizedToTest: false, idempotencyKey: "k" }).success).toBe(false);
    const accept = TOOLS.find((t) => t.name === "accept_quote")!;
    expect(accept.inputSchema.safeParse({ jobId: A_JOB, quoteVersion: 1, pricingMode: "free" }).success).toBe(false);
    expect(accept.inputSchema.safeParse({ jobId: A_JOB, quoteVersion: 1, pricingMode: "per_finding" }).success).toBe(true);
  });
  it("exposes the eight tools", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["list_packages", "create_job", "get_job", "answer_clarification", "accept_quote", "get_report", "rerun_finding", "cancel_job"]);
    for (const t of TOOLS) expect(t.description.length).toBeGreaterThan(40);
  });
});

describe("list_packages", () => {
  it("shows both pricing modes with $25 per finding and caps", () => {
    const p = listPackages().packages.find((x) => x.package === "version_comparison")!;
    expect(p.priceCents).toBe(29900);
    expect(p.pricing.fixed.chargeCents).toBe(29900);
    expect(p.pricing.per_finding).toMatchObject({ perConfirmedFindingCents: 2500, capCents: 25000 });
  });
});

describe("get_job / get_report", () => {
  it("get_job returns findings, remediations, summary and nextAction", async () => {
    const r = (await getJob(A, A_JOB)).structuredContent!;
    expect(r.confirmedFindingCount).toBe(1);
    expect(r.summary).toBe("2 findings");
    expect(r.nextAction).toContain("answer_clarification");
    expect((r.remediations as unknown[]).length).toBe(1);
  });
  it("get_job exposes pricing options on a quote", async () => {
    jobs[A_JOB].state = "quoted";
    const q = (await getJob(A, A_JOB)).structuredContent!.quote as { pricingOptions: { per_finding: { capCents: number } } };
    expect(q.pricingOptions.per_finding.capCents).toBe(25000);
  });
  it("get_report truncates evidence, links remediations by findingKey and returns markdown", async () => {
    const r = (await getReport(A, A_JOB)).structuredContent as { findings: Array<{ id: string; findingKey: string; evidence: Array<{ excerpt: string }> }>; reportMarkdown: string; remediations: Array<{ findingId: string }> };
    expect(r.findings[0]).toMatchObject({ id: FINDING_ROW, findingKey: "F-1" });
    expect(r.findings[0].evidence[0].excerpt.length).toBeLessThan(700);
    expect(r.reportMarkdown).toBe("# Report");
    expect(r.remediations[0].findingId).toBe("F-1");
  });
});

describe("accept_quote", () => {
  beforeEach(() => { jobs[A_JOB].state = "quoted"; });
  it("returns a Stripe checkout URL in per_finding mode at the cap and notifies the workflow", async () => {
    const r = await acceptQuote(A, A_JOB, 2, "per_finding");
    expect(r.isError).toBeUndefined();
    expect(createCheckoutForQuote).toHaveBeenCalledWith(expect.objectContaining({ pricingMode: "per_finding", priceCents: 25000, customerEmail: "a@x.com" }));
    expect(r.structuredContent).toMatchObject({ checkoutUrl: "https://checkout.stripe.test/cs_new", capCents: 25000, pricingMode: "per_finding" });
    expect(sendJobEvent).toHaveBeenCalledWith(A_JOB, { type: "quote_accepted", quoteVersion: 2 });
  });
  it("defaults to fixed at the quote price", async () => {
    await acceptQuote(A, A_JOB, 2);
    expect(createCheckoutForQuote).toHaveBeenCalledWith(expect.objectContaining({ pricingMode: "fixed", priceCents: 9900 }));
  });
  it("rejects a stale quote version and a job not in quoted state", async () => {
    const stale = await acceptQuote(A, A_JOB, 1);
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toContain("out of date");
    jobs[A_JOB].state = "running";
    expect((await acceptQuote(A, A_JOB, 2)).isError).toBe(true);
    expect(createCheckoutForQuote).not.toHaveBeenCalled();
  });
});

describe("cancel_job", () => {
  it("accepts durable intent even when immediate delivery fails", async () => {
    dispatchJobCancellation.mockRejectedValueOnce(new Error("offline"));
    expect((await cancelJob(A, A_JOB)).isError).toBeUndefined();
  });

  it("records using authenticated identity and dispatches the durable request", async () => {
    jobs[A_JOB].state = "quoted";
    const r = await cancelJob(A, A_JOB, "changed my mind");
    expect(r.isError).toBeUndefined();
    expect(requestJobCancellation).toHaveBeenCalledWith(A_JOB, { id: "A", allowOperator: false }, "changed my mind");
    expect(dispatchJobCancellation).toHaveBeenCalledWith(A_JOB);
  });
  it("refuses once work has started", async () => {
    jobs[A_JOB].state = "running";
    const r = await cancelJob(A, A_JOB);
    expect(r.isError).toBe(true);
    expect(sendJobEvent).not.toHaveBeenCalled();
  });
});

describe("sample report", () => {
  it("renders findings, fixes and pricing as markdown", () => {
    const md = sampleReportMarkdown("https://x.test");
    expect(md).toContain("## Findings");
    expect(md).toContain("## Verified fixes");
    expect(md).toContain("https://x.test/sample");
  });
});
