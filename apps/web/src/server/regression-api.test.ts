import { beforeEach, describe, expect, it, vi } from "vitest";

const JOB = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB = "22222222-2222-4222-8222-222222222222";
const SECRET = "sk-target-SECRET-123";
const h = vi.hoisted(() => ({
  verifyApiKey: vi.fn(), rateLimit: vi.fn(), runSuite: vi.fn(), assertPublicTarget: vi.fn(),
  getJobForViewer: vi.fn(), getJobWithDecryptedCredentials: vi.fn(), makeServiceContext: vi.fn(), readBlob: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("./api-keys", () => ({ verifyApiKey: h.verifyApiKey }));
vi.mock("./rate-limit", () => ({ rateLimit: h.rateLimit }));
vi.mock("./queries", () => ({ getJobForViewer: h.getJobForViewer }));
vi.mock("./job-store", () => ({ getJobWithDecryptedCredentials: h.getJobWithDecryptedCredentials, makeServiceContext: h.makeServiceContext }));
vi.mock("./services", () => ({ getEvalServices: async () => ({ runSuite: h.runSuite }) }));
vi.mock("./target-url", () => ({ assertPublicTarget: h.assertPublicTarget }));
vi.mock("./monitoring", () => ({ targetFromIntake: (i: { endpoint?: { url: string; model: string; apiKey?: string; systemPrompt?: string } }) => i.endpoint ? { systemPrompt: "", ...i.endpoint } : null }));
vi.mock("@ae/core/storage/blob", () => ({ readJobArtifactText: h.readBlob }));
vi.mock("@ae/core/db/client", () => ({ db: () => ({ execute: async () => { throw new Error("no table"); } }) }));

import { handleCreateRegressionRun, handleGetRegressionRun } from "./regression-api";
import { MONITORING_RUN_BUDGET_MICRO_USD } from "@ae/core/contracts/index";
import type { RegressionRunRecord, RegressionRunStore } from "./regression-store";

const suiteJson = JSON.stringify({
  jobId: JOB, versionLabel: "default", frozenAt: new Date().toISOString(),
  scenarios: [{ id: "s1", title: "Refund", category: "c", input: "hi", checks: [{ kind: "objective", description: "d", spec: {} }] }],
});
const memStore = (): RegressionRunStore & { rows: Map<string, RegressionRunRecord> } => {
  const rows = new Map<string, RegressionRunRecord>();
  return { rows, save: async (r) => { rows.set(r.runId, r); }, get: async (id) => rows.get(id) ?? null };
};
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://x.test/api/v1/regression-runs", { method: "POST", headers: { authorization: "Bearer se_k", ...headers }, body: JSON.stringify(body) });

let store: ReturnType<typeof memStore>;
const defer = vi.fn();

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  defer.mockReset();
  store = memStore();
  h.verifyApiKey.mockImplementation(async (b?: string) => (b === "se_k" ? { keyId: "k1", customerId: "A", email: "a@x.test" } : null));
  h.rateLimit.mockResolvedValue({ ok: true, retryAfter: 0 });
  h.getJobForViewer.mockImplementation(async (id: string, v: { id: string }) => id === JOB && v.id === "A"
    ? { findings: [{ data: { id: "F-1", scenarioId: "s1" } }], remediations: [{ id: "r1", findingId: "F-1", verification: { status: "verified" } }] } : null);
  h.getJobWithDecryptedCredentials.mockResolvedValue({
    job: { id: JOB, package: "text_eval", isMock: false, suiteBlobPath: "blob:suite" },
    intake: { endpoint: { url: "https://orig.test/v1", model: "m", apiKey: "stored-key" } },
  });
  h.readBlob.mockResolvedValue(suiteJson);
  h.assertPublicTarget.mockResolvedValue(null);
  h.makeServiceContext.mockResolvedValue({ jobId: JOB, budgetMicroUsd: 99 });
  h.runSuite.mockResolvedValue({ runId: "r", versionLabel: "d", results: [{ scenarioId: "s1", passed: false, detail: "broke" }] });
});

describe("auth and ownership", () => {
  it("401 without a valid key", async () => {
    const r = await handleCreateRegressionRun(post({ jobId: JOB }, { authorization: "Bearer nope" }), { defer, store });
    expect(r.status).toBe(401);
    expect(h.runSuite).not.toHaveBeenCalled();
  });
  it("429 when rate limited", async () => {
    h.rateLimit.mockResolvedValue({ ok: false, retryAfter: 30 });
    const r = await handleCreateRegressionRun(post({ jobId: JOB }), { defer, store });
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("30");
    expect(h.rateLimit.mock.calls[0]![0]).toMatch(/:customer:A$/); // per customer, not per API key
  });
  it("404 for a job the caller does not own", async () => {
    const r = await handleCreateRegressionRun(post({ jobId: OTHER_JOB }), { defer, store });
    expect(r.status).toBe(404);
    expect(h.runSuite).not.toHaveBeenCalled();
  });
  it("polling another customer's run is 404", async () => {
    store.rows.set("33333333-3333-4333-8333-333333333333", { runId: "33333333-3333-4333-8333-333333333333", jobId: JOB, customerId: "B", status: "running", createdAt: "" });
    const r = await handleGetRegressionRun(new Request("https://x.test", { headers: { authorization: "Bearer se_k" } }), "33333333-3333-4333-8333-333333333333", { store });
    expect(r.status).toBe(404);
  });
});

describe("running", () => {
  it("returns the verdict synchronously with previouslyFixedRegressed", async () => {
    const r = await handleCreateRegressionRun(post({ jobId: JOB }), { defer, store });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ status: "completed", passed: 0, total: 1 });
    expect(body.failed[0]).toMatchObject({ scenarioId: "s1", title: "Refund" });
    expect(body.previouslyFixedRegressed).toHaveLength(1);
  });
  it("caps the per-run budget at the monitoring budget", async () => {
    await handleCreateRegressionRun(post({ jobId: JOB }), { defer, store });
    expect(h.runSuite.mock.calls[0][0].budgetMicroUsd).toBe(MONITORING_RUN_BUDGET_MICRO_USD);
  });
  it("rejects a non-public target", async () => {
    h.assertPublicTarget.mockResolvedValue("private address not allowed");
    const r = await handleCreateRegressionRun(post({ jobId: JOB, targetUrl: "https://10.0.0.1" }), { defer, store });
    expect(r.status).toBe(400);
    expect(h.runSuite).not.toHaveBeenCalled();
  });
  it("hands back a runId and defers when the run outlasts the sync window", async () => {
    h.runSuite.mockImplementation(() => new Promise((res) => setTimeout(() => res({ runId: "r", versionLabel: "d", results: [{ scenarioId: "s1", passed: true, detail: "" }] }), 40)));
    const r = await handleCreateRegressionRun(post({ jobId: JOB }), { defer, store, syncMs: 5 });
    expect(r.status).toBe(202);
    const { runId } = await r.json();
    expect(defer).toHaveBeenCalledTimes(1);
    await defer.mock.calls[0][0];
    const poll = await handleGetRegressionRun(new Request("https://x.test", { headers: { authorization: "Bearer se_k" } }), runId, { store });
    expect(await poll.json()).toMatchObject({ status: "completed", passed: 1, total: 1 });
  });
});

describe("target secret", () => {
  it("passes the header key to the target but never echoes or stores it", async () => {
    const r = await handleCreateRegressionRun(post({ jobId: JOB }, { "x-target-authorization": `Bearer ${SECRET}` }), { defer, store });
    expect(h.runSuite.mock.calls[0][2].apiKey).toBe(SECRET);
    expect(JSON.stringify(await r.json())).not.toContain(SECRET);
    expect(JSON.stringify([...store.rows.values()])).not.toContain(SECRET);
  });
  it("redacts the secret from error output", async () => {
    h.runSuite.mockRejectedValue(new Error(`upstream 401 for key ${SECRET}`));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await handleCreateRegressionRun(post({ jobId: JOB }, { "x-target-authorization": SECRET }), { defer, store });
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toContain(SECRET);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify([...store.rows.values()])).not.toContain(SECRET);
    spy.mockRestore();
  });
  it("does not forward the stored key to an overridden host", async () => {
    await handleCreateRegressionRun(post({ jobId: JOB, targetUrl: "https://other.test/v1" }), { defer, store });
    expect(h.runSuite.mock.calls[0][2].apiKey).toBeUndefined();
  });
  it("uses the stored key for the original endpoint", async () => {
    await handleCreateRegressionRun(post({ jobId: JOB }), { defer, store });
    expect(h.runSuite.mock.calls[0][2].apiKey).toBe("stored-key");
  });
});
