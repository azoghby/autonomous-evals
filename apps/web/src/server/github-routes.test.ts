import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "github_pat_" + "B".repeat(30);
const JOB = "11111111-1111-4111-8111-111111111111";
const REM = "22222222-2222-4222-8222-222222222222";
const h = vi.hoisted(() => ({
  me: { id: "u1", email: "a@x.io", isOperator: false } as any,
  job: { id: "11111111-1111-4111-8111-111111111111", customerId: "u1", credentialsDeleteAfter: null } as any,
  rate: vi.fn(), connectRepo: vi.fn(), openPr: vi.fn(),
}));
vi.mock("@/server/queries", () => ({ getCurrentCustomer: async () => h.me }));
vi.mock("@/server/job-store", () => ({ getJob: async () => h.job }));
vi.mock("@/server/rate-limit", () => ({ rateLimit: h.rate }));
vi.mock("@/server/idempotency", () => ({
  IdempotencyInProgressError: class extends Error {},
  withIdempotency: async (_k: string, fn: () => Promise<{ status: number; body: unknown }>) => fn(),
}));
vi.mock("@/server/github-service", async (orig) => ({
  ...(await orig<typeof import("@/server/github-service")>()),
  connectRepo: h.connectRepo,
  connectionStatus: async () => ({ connected: true, owner: "acme", repo: "bot", baseBranch: "main", filePath: "p.md", prs: {} }),
  openRemediationPr: h.openPr,
}));

import { POST as connect } from "../app/api/jobs/[jobId]/github/route";
import { POST as openPr } from "../app/api/jobs/[jobId]/remediations/[remediationId]/pr/route";

const body = { owner: "acme", repo: "bot", baseBranch: "main", filePath: "p.md", token: TOKEN };
const req = (b?: unknown, key: string | null = "k1") => new Request("http://x/api", {
  method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
  body: b === undefined ? undefined : JSON.stringify(b),
});
const c1 = { params: Promise.resolve({ jobId: JOB }) };
const c2 = { params: Promise.resolve({ jobId: JOB, remediationId: REM }) };

beforeEach(() => {
  vi.clearAllMocks();
  h.me = { id: "u1", email: "a@x.io", isOperator: false };
  h.job = { id: JOB, customerId: "u1", credentialsDeleteAfter: null };
  h.rate.mockResolvedValue({ ok: true, retryAfter: 0 });
  h.connectRepo.mockResolvedValue(undefined);
  h.openPr.mockResolvedValue({ status: 201, body: { prUrl: "https://github.com/acme/bot/pull/9" } });
});

describe("POST /github", () => {
  it("saves and never echoes the token", async () => {
    const res = await connect(req(body), c1);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(TOKEN);
    expect(h.connectRepo).toHaveBeenCalled();
  });
  it("404 for non-owners (including operators) and 401 when signed out", async () => {
    h.me = { id: "other", email: "o@x.io", isOperator: false };
    expect((await connect(req(body), c1)).status).toBe(404);
    h.me = { id: "op", email: "op@x.io", isOperator: true };
    expect((await connect(req(body), c1)).status).toBe(404);
    h.me = null;
    expect((await connect(req(body), c1)).status).toBe(401);
    expect(h.connectRepo).not.toHaveBeenCalled();
  });
  it("requires an idempotency key and strict input, without echoing the token", async () => {
    expect((await connect(req(body, null), c1)).status).toBe(400);
    const bad = await connect(req({ ...body, filePath: "../../etc/passwd" }), c1);
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain(TOKEN);
    expect((await connect(req({ ...body, owner: "evil.com/x" }), c1)).status).toBe(400);
    expect((await connect(req({ ...body, token: "ghp_" + "a".repeat(36) }), c1)).status).toBe(400);
  });
  it("rate limits", async () => {
    h.rate.mockResolvedValue({ ok: false, retryAfter: 9 });
    const res = await connect(req(body), c1);
    expect(res.status).toBe(429);
    expect(h.connectRepo).not.toHaveBeenCalled();
  });
  it("maps a GitHub auth failure to 422 without leaking the token", async () => {
    const { GithubError } = await import("@/server/github-pr");
    h.connectRepo.mockRejectedValue(new GithubError(401, `Bad credentials ${TOKEN}`));
    const res = await connect(req(body), c1);
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain(TOKEN);
  });
});

describe("POST /remediations/[id]/pr", () => {
  it("returns the PR url for the owner", async () => {
    const res = await openPr(req(), c2);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ prUrl: "https://github.com/acme/bot/pull/9" });
    expect(h.rate).toHaveBeenCalledWith("github-pr:u1", 10, 600);
  });
  it("404 for non-owners, never touching GitHub", async () => {
    h.me = { id: "other", email: "o@x.io", isOperator: true };
    expect((await openPr(req(), c2)).status).toBe(404);
    expect(h.openPr).not.toHaveBeenCalled();
  });
  it("429 when rate limited; 404 for bad remediation id; 400 without key", async () => {
    h.rate.mockResolvedValue({ ok: false, retryAfter: 3 });
    expect((await openPr(req(), c2)).status).toBe(429);
    h.rate.mockResolvedValue({ ok: true, retryAfter: 0 });
    expect((await openPr(req(), { params: Promise.resolve({ jobId: JOB, remediationId: "nope" }) })).status).toBe(404);
    expect((await openPr(req(undefined, null), c2)).status).toBe(400);
    expect(h.openPr).not.toHaveBeenCalled();
  });
});
