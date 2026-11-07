import { beforeEach, describe, expect, it, vi } from "vitest";

const jobs: Record<string, { customerId: string }> = {
  "11111111-1111-4111-8111-111111111111": { customerId: "A" },
  "22222222-2222-4222-8222-222222222222": { customerId: "B" },
};
const getJobForViewer = vi.fn(async (jobId: string, viewer: { id: string; isOperator: boolean }) => {
  const j = jobs[jobId];
  if (!j || (j.customerId !== viewer.id && !viewer.isOperator)) return null;
  return { job: { id: jobId, state: "needs_clarification", package: "trace_audit", error: null }, quotes: [], messages: [{ role: "commercial", body: "Which tool failed?" }], progress: [], findings: [], payments: [] };
});
const createJob = vi.fn(async () => ({ jobId: "33333333-3333-4333-8333-333333333333" }));
vi.mock("./queries", () => ({ getJobForViewer }));
vi.mock("./create-job", () => ({ createJob }));
vi.mock("./idempotency", () => ({
  IdempotencyInProgressError: class extends Error {},
  withIdempotency: async (_k: string, fn: () => Promise<{ status: number; body: unknown }>) => ({ ...(await fn()), replayed: false }),
}));
vi.mock("./job-actions", () => ({ submitClarificationAnswer: vi.fn(async () => ({ ok: true, value: { messageId: "m" } })), rerunFindingForJob: vi.fn() }));
vi.mock("./job-store", () => ({ latestQuote: vi.fn(async () => null) }));
vi.mock("@ae/core/db/client", () => ({ db: () => ({}), schema: { remediations: {} } }));

const { TOOLS, getJob, getReport, answerClarification, acceptQuote, requestEval, listServices } = await import("./mcp-tools");

const A = { customerId: "A", email: "a@x.com", origin: "https://x.test" };
const B = { customerId: "B", email: "b@x.com", origin: "https://x.test" };
const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => vi.clearAllMocks());

describe("MCP tool ownership", () => {
  it("owner can read their job", async () => {
    const r = await getJob(A, JOB_A);
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent?.pendingClarificationQuestions).toEqual(["Which tool failed?"]);
  });
  it("key A cannot read, answer, accept, or report on customer B's job (looks like not found)", async () => {
    for (const r of [await getJob(A, JOB_B), await answerClarification(A, JOB_B, "x"), await acceptQuote(A, JOB_B, 1), await getReport(A, JOB_B)]) {
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Job not found");
    }
  });
  it("never grants operator powers even if the owner's email is an operator", async () => {
    await getJob(B, JOB_A);
    expect(getJobForViewer.mock.calls[0][1]).toMatchObject({ id: "B", isOperator: false });
  });
});

describe("MCP tool validation", () => {
  it("request_eval rejects a package missing its inputs without creating a job", async () => {
    const r = await requestEval(A, { package: "text_eval", authorizedToTest: true, idempotencyKey: "k" });
    expect(r.isError).toBe(true);
    expect(createJob).not.toHaveBeenCalled();
  });
  it("request_eval creates a job for a valid trace_audit", async () => {
    const r = await requestEval(A, { package: "trace_audit", trace: "user: hi", authorizedToTest: true, idempotencyKey: "k" });
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ customerId: "A", idempotencyKey: "k" }));
    expect(r.structuredContent?.jobUrl).toBe("https://x.test/jobs/33333333-3333-4333-8333-333333333333");
  });
  it("input schemas reject non-uuid job ids and authorizedToTest=false", () => {
    const get = TOOLS.find((t) => t.name === "get_job")!;
    expect(get.inputSchema.safeParse({ jobId: "nope" }).success).toBe(false);
    const req = TOOLS.find((t) => t.name === "request_eval")!;
    expect(req.inputSchema.safeParse({ package: "trace_audit", trace: "x", authorizedToTest: false, idempotencyKey: "k" }).success).toBe(false);
  });
  it("exposes the seven tools and list_services carries prices", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["list_services", "request_eval", "get_job", "answer_clarification", "accept_quote", "get_report", "rerun_finding"]);
    expect(listServices().packages[0].priceCents).toBeGreaterThan(0);
  });
});
