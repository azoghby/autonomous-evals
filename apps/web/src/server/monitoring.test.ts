import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  subs: [] as unknown[],
  existing: [] as unknown[],
  prev: [] as unknown[],
  customer: [{ email: "c@example.com" }] as unknown[],
  insertReturning: [{ id: "run1" }] as unknown[],
  inserts: [] as unknown[],
  updates: 0,
  jobs: new Map<string, unknown>(),
  runSuite: vi.fn(),
  sendEmail: vi.fn(),
  emailConfigured: true,
  addMessage: vi.fn(),
  recordEmailThread: vi.fn(),
  readBlob: vi.fn(),
}));

vi.mock("@ae/core/db/client", async () => {
  const schema = await import("@ae/core/db/schema");
  const rowsFor = (t: unknown, phase: "sub" | "run") => {
    if (t === schema.monitoringSubscriptions) return h.subs;
    if (t === schema.customers) return h.customer;
    if (t === schema.monitoringRuns) return phase === "run" ? h.existing : h.prev;
    return [];
  };
  const select = (cols?: Record<string, unknown>) => ({
    from: (t: unknown) => {
      // The "already ran today" lookup selects `id`; the previous-run lookup selects `results`.
      const phase = cols && "results" in cols ? "prev" : "run";
      const rows = () => rowsFor(t, phase);
      const chain: Record<string, unknown> = {
        where: () => chain, orderBy: () => chain, limit: () => chain,
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(rows()).then(res, rej),
      };
      return chain;
    },
  });
  return {
    schema,
    db: () => ({
      select,
      insert: () => ({ values: (v: unknown) => ({ onConflictDoNothing: () => ({ returning: async () => { h.inserts.push(v); return h.insertReturning; } }) }) }),
      update: () => ({ set: () => ({ where: async () => { h.updates++; } }) }),
    }),
  };
});
vi.mock("./services", () => ({ getEvalServices: async () => ({ runSuite: h.runSuite }) }));
vi.mock("./job-store", () => ({
  getJobWithDecryptedCredentials: async (id: string) => h.jobs.get(id) ?? null,
  makeServiceContext: async (jobId: string) => ({ jobId, environment: "test", budgetMicroUsd: 5, recordCost: vi.fn(), recordProgress: vi.fn() }),
  addMessage: h.addMessage,
}));
vi.mock("./email-threads", () => ({ recordEmailThread: h.recordEmailThread }));
vi.mock("@ae/core/auth/email", () => ({ sendEmail: h.sendEmail, isEmailConfigured: () => h.emailConfigured }));
vi.mock("@ae/core/storage/blob", () => ({ readJobArtifactText: h.readBlob }));

import { buildRegressionEmail, detectRegressions, runMonitoring, targetFromIntake } from "./monitoring";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const suiteJson = JSON.stringify({
  jobId: JOB_ID, versionLabel: "default", frozenAt: new Date().toISOString(),
  scenarios: [{ id: "s1", title: "t", category: "c", input: "hi", checks: [{ kind: "objective", description: "d", spec: {} }] }],
});
const sub = (id: string, over: Record<string, unknown> = {}) => ({ id, jobId: JOB_ID, customerId: "cust", status: "active", environment: "test", ...over });
const job = (over: Record<string, unknown> = {}) => ({
  job: { id: JOB_ID, package: "text_eval", isMock: false, suiteBlobPath: "blob:suite", ...over },
  intake: { package: "text_eval", endpoint: { url: "https://x.test/v1", model: "m", apiKey: "k", systemPrompt: "" } },
  credentials: {}, credentialsPresent: true,
});
const r = (scenarioId: string, passed: boolean) => ({ scenarioId, passed, detail: passed ? "ok" : "bad" });

beforeEach(() => {
  Object.assign(h, { subs: [], existing: [], prev: [], customer: [{ email: "c@example.com" }], insertReturning: [{ id: "run1" }], inserts: [], updates: 0, emailConfigured: true });
  h.jobs = new Map([[JOB_ID, job()]]);
  for (const f of [h.runSuite, h.sendEmail, h.addMessage, h.recordEmailThread, h.readBlob]) f.mockReset();
  h.readBlob.mockResolvedValue(suiteJson);
  h.sendEmail.mockResolvedValue({ id: "m1", threadId: "t1" });
  h.runSuite.mockResolvedValue({ runId: "r", versionLabel: "default", results: [r("s1", true)] });
  delete process.env.MONITORING_INCLUDE_MOCK;
  delete process.env.STRIPE_MODE;
});

describe("detectRegressions", () => {
  it("flags only pass -> fail", () => {
    expect(detectRegressions([r("a", true), r("b", false), r("c", true)], [r("a", false), r("b", false), r("c", true), r("d", false)]).map((x) => x.scenarioId)).toEqual(["a"]);
  });
  it("returns none for a baseline run", () => {
    expect(detectRegressions(undefined, [r("a", false)])).toEqual([]);
    expect(detectRegressions([], [r("a", false)])).toEqual([]);
  });
});

describe("helpers", () => {
  it("picks endpoint, else endpointB", () => {
    expect(targetFromIntake({ endpointA: { url: "a", model: "m" }, endpointB: { url: "b", model: "m" } })?.url).toBe("b");
    expect(targetFromIntake({ package: "trace_audit" })).toBeNull();
  });
  it("email lists scenarios, truncates detail, links the job", () => {
    const e = buildRegressionEmail(JOB_ID, [{ scenarioId: "s1", passed: false, detail: "x".repeat(500) }]);
    expect(e.text).toContain("- s1:");
    expect(e.text).toContain(`/jobs/${JOB_ID}`);
    expect(e.text.length).toBeLessThan(900);
  });
});

describe("runMonitoring selection", () => {
  it("skips trace_audit, missing suite, and mock jobs; runs mock with override", async () => {
    h.subs = [sub("s1")];
    h.jobs.set(JOB_ID, job({ package: "trace_audit" }));
    let out = await runMonitoring();
    expect(out.skippedDetail[0]?.reason).toBe("trace_audit_has_no_suite");

    h.jobs.set(JOB_ID, job({ suiteBlobPath: null }));
    out = await runMonitoring();
    expect(out.skippedDetail[0]?.reason).toBe("no_frozen_suite");

    h.jobs.set(JOB_ID, job({ isMock: true }));
    out = await runMonitoring();
    expect(out.skippedDetail[0]?.reason).toBe("mock_job");
    expect(h.runSuite).not.toHaveBeenCalled();

    process.env.MONITORING_INCLUDE_MOCK = "1";
    out = await runMonitoring();
    expect(out.processed).toBe(1);
  });

  it("skips targets that fail the URL guard without running the suite", async () => {
    h.subs = [sub("s1")];
    for (const url of ["http://x.test/v1", "https://localhost/v1", "https://10.0.0.5/v1", "https://169.254.169.254/latest"]) {
      h.jobs.set(JOB_ID, { ...job(), intake: { package: "text_eval", endpoint: { url, model: "m", apiKey: "k", systemPrompt: "" } } });
      const out = await runMonitoring();
      expect(out.skippedDetail[0]?.reason).toBe("target_rejected");
    }
    expect(h.runSuite).not.toHaveBeenCalled();
  });

  it("runs the suite with the monitoring budget and stores the baseline without emailing", async () => {
    h.subs = [sub("s1")];
    const out = await runMonitoring();
    expect(out).toMatchObject({ processed: 1, sent: 0, skipped: 0, errors: [] });
    expect(h.runSuite.mock.calls[0]![0].budgetMicroUsd).toBe(1_000_000);
    expect(h.inserts).toHaveLength(1);
    expect(h.updates).toBe(1);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});

describe("idempotency", () => {
  it("does nothing when a run for today exists", async () => {
    h.subs = [sub("s1")];
    h.existing = [{ id: "old" }];
    const out = await runMonitoring();
    expect(out.skippedDetail).toEqual([{ subscriptionId: "s1", reason: "already_ran_today" }]);
    expect(h.runSuite).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
  it("does not email when a concurrent invocation won the insert", async () => {
    h.subs = [sub("s1")];
    h.prev = [{ results: [r("s1", true)] }];
    h.runSuite.mockResolvedValue({ runId: "r", versionLabel: "d", results: [r("s1", false)] });
    h.insertReturning = [];
    const out = await runMonitoring();
    expect(out.processed).toBe(0);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});

describe("regression alerts", () => {
  beforeEach(() => {
    h.subs = [sub("s1")];
    h.prev = [{ results: [r("s1", true)] }];
  });
  it("emails once on pass -> fail and records the thread", async () => {
    h.runSuite.mockResolvedValue({ runId: "r", versionLabel: "d", results: [r("s1", false)] });
    const out = await runMonitoring();
    expect(out).toMatchObject({ processed: 1, sent: 1 });
    expect(h.sendEmail).toHaveBeenCalledOnce();
    expect(h.sendEmail.mock.calls[0]![0]).toMatchObject({ to: "c@example.com", purpose: "commercial" });
    expect(h.recordEmailThread).toHaveBeenCalledWith("t1", "commercial", { jobId: JOB_ID });
    expect(h.addMessage).toHaveBeenCalledOnce();
  });
  it("does not email when nothing regressed", async () => {
    const out = await runMonitoring();
    expect(out.sent).toBe(0);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
  it("counts skipped when email is not configured", async () => {
    h.emailConfigured = false;
    h.runSuite.mockResolvedValue({ runId: "r", versionLabel: "d", results: [r("s1", false)] });
    const out = await runMonitoring();
    expect(out).toMatchObject({ processed: 1, sent: 0, skipped: 1 });
    expect(out.skippedDetail[0]?.reason).toBe("email_not_configured");
  });
});

describe("isolation and deadline", () => {
  it("one failing subscription does not stop the others", async () => {
    h.subs = [sub("bad"), sub("good")];
    h.runSuite.mockRejectedValueOnce(new Error("boom"));
    const out = await runMonitoring({ concurrency: 1 });
    expect(out.errors).toEqual(["bad: boom"]);
    expect(out.processed).toBe(1);
  });
  it("reports remaining subscriptions as skipped after the deadline", async () => {
    h.subs = [sub("a"), sub("b")];
    const out = await runMonitoring({ deadlineMs: 0 });
    expect(out.skippedDetail.map((s) => s.reason)).toEqual(["deadline", "deadline"]);
    expect(h.runSuite).not.toHaveBeenCalled();
  });
});
