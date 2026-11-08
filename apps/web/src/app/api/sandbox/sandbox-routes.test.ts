import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const viewer = vi.hoisted(() => ({ current: null as { id: string } | null }));
vi.mock("@/server/session", () => ({ getCurrentCustomer: async () => viewer.current }));
vi.mock("@/server/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true, retryAfter: 0 })), clientIp: () => "1.1.1.1" }));
vi.mock("@/server/bot", () => ({ assertHuman: vi.fn(async () => null) }));
vi.mock("@/server/target-url", () => ({
  assertPublicTarget: vi.fn(async (url: string) => (url.startsWith("https://") ? null : "only https is allowed")),
}));

const stub = vi.hoisted(() => ({ current: null as null | { createDraft?: (...a: unknown[]) => Promise<unknown>; startRun?: (...a: unknown[]) => Promise<unknown> } }));
vi.mock("@/server/sandbox-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/sandbox-service")>();
  return {
    ...actual,
    getSandboxService: () => {
      const fixture = actual.getFixtureSandboxService();
      return stub.current ? { ...fixture, ...stub.current } : fixture;
    },
  };
});

import { POST as createDraft } from "./drafts/route";
import { GET as getDraft } from "./drafts/[draftId]/route";
import { PATCH as reviewScenario } from "./drafts/[draftId]/scenarios/[scenarioId]/route";
import { POST as startRun } from "./drafts/[draftId]/runs/route";
import { GET as getRun } from "./runs/[runId]/route";
import { rateLimit } from "@/server/rate-limit";
import { assertPublicTarget } from "@/server/target-url";
import { SandboxInputError } from "@/server/sandbox/target";
import { SAMPLE_SCENARIOS } from "@/components/sandbox/sample-data";

const A = { id: "user-a" }, B = { id: "user-b" };
const FIRST = SAMPLE_SCENARIOS[0].id;
const FUNCTIONS = JSON.stringify([{ type: "function", function: { name: "lookup_customer" } }, { type: "function", function: { name: "issue_refund" } }]);

const intake = (over: Record<string, unknown> = {}) => ({
  name: "Acme Support",
  domain: "Support",
  integration: { mode: "tool_loop", endpointUrl: "https://agent.example.com/v1/chat/completions", model: "acme-1" },
  world: { tools: { format: "function_json", content: FUNCTIONS }, data: { format: "infer", content: "" } },
  ...over,
});
const post = (body: unknown, raw = false) =>
  new Request("http://x/api", { method: "POST", body: raw ? (body as string) : JSON.stringify(body) });
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });
const patch = (body: unknown) => new Request("http://x/api", { method: "PATCH", body: JSON.stringify(body) });

async function makeDraft(user = A) {
  viewer.current = user;
  const res = await createDraft(post(intake()));
  return ((await res.json()) as { draft: { draftId: string } }).draft.draftId;
}
const review = (draftId: string, scenarioId: string, body: unknown) =>
  reviewScenario(patch(body), params({ draftId, scenarioId }));

beforeEach(() => {
  viewer.current = A;
  stub.current = null;
  (globalThis as { __aeSandboxFixtureStore?: unknown }).__aeSandboxFixtureStore = undefined;
  vi.mocked(rateLimit).mockResolvedValue({ ok: true, retryAfter: 0 });
  vi.mocked(assertPublicTarget).mockClear();
});

describe("auth", () => {
  it("returns 401 on every route when signed out", async () => {
    viewer.current = null;
    const id = "drf_" + "0".repeat(36);
    const responses = await Promise.all([
      createDraft(post(intake())),
      getDraft(new Request("http://x/api"), params({ draftId: id })),
      reviewScenario(patch({ decision: "accepted" }), params({ draftId: id, scenarioId: FIRST })),
      startRun(post({}), params({ draftId: id })),
      getRun(new Request("http://x/api"), params({ runId: "sample" })),
    ]);
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
  });
});

describe("POST /api/sandbox/drafts", () => {
  it("creates a sample draft with scenarios", async () => {
    const res = await createDraft(post(intake()));
    expect(res.status).toBe(201);
    const { draft } = await res.json();
    expect(draft.sample).toBe(true);
    expect(draft.scenarios.length).toBeGreaterThan(0);
    expect(draft.environment.tools.map((t: { name: string }) => t.name)).toEqual(["lookup_customer", "issue_refund"]);
  });
  it("rejects invalid JSON with 400", async () => {
    expect((await createDraft(post("{nope", true))).status).toBe(400);
  });
  it("rejects missing tools content with 400", async () => {
    const body = intake({ world: { tools: { format: "function_json", content: "" }, data: { format: "infer" } } });
    const res = await createDraft(post(body));
    expect(res.status).toBe(400);
    expect((await res.json()).issues).toBeTruthy();
  });
  it("rejects function JSON that does not parse with 400", async () => {
    const body = intake({ world: { tools: { format: "function_json", content: "{not json" }, data: { format: "infer" } } });
    expect((await createDraft(post(body))).status).toBe(400);
  });
  it("rejects an http:// endpoint with 422 and the field", async () => {
    const res = await createDraft(post(intake({ integration: { mode: "tool_loop", endpointUrl: "http://agent.example.com/x", model: "m" } })));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ field: "integration.endpointUrl" });
  });
  it("rejects a private-resolving host with 422", async () => {
    vi.mocked(assertPublicTarget).mockResolvedValueOnce("host resolves to a private address");
    const res = await createDraft(post(intake()));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Target URL rejected: host resolves to a private address", field: "integration.endpointUrl" });
  });
  it("rejects voice mode over ws:// with 422", async () => {
    const res = await createDraft(post(intake({ integration: { mode: "realtime_voice", wsUrl: "ws://voice.example.com/rt", protocol: "openai_realtime" } })));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ field: "integration.wsUrl" });
  });
  it("accepts voice mode over wss://", async () => {
    const res = await createDraft(post(intake({ integration: { mode: "realtime_voice", wsUrl: "wss://voice.example.com/rt", protocol: "openai_realtime" } })));
    expect(res.status).toBe(201);
    expect(vi.mocked(assertPublicTarget)).toHaveBeenCalledWith("https://voice.example.com/rt");
  });
  it("returns 429 with Retry-After when rate limited", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, retryAfter: 42 });
    const res = await createDraft(post(intake()));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
  });
});

describe("ownership", () => {
  it("hides user A's draft and run from user B", async () => {
    const draftId = await makeDraft(A);
    await review(draftId, FIRST, { decision: "accepted" });
    const run = await startRun(post({}), params({ draftId }));
    const { runId } = await run.json();

    viewer.current = B;
    expect((await getDraft(new Request("http://x/api"), params({ draftId }))).status).toBe(404);
    expect((await review(draftId, FIRST, { decision: "rejected" })).status).toBe(404);
    expect((await startRun(post({}), params({ draftId }))).status).toBe(404);
    expect((await getRun(new Request("http://x/api"), params({ runId }))).status).toBe(404);

    viewer.current = A;
    expect((await getRun(new Request("http://x/api"), params({ runId }))).status).toBe(200);
  });
  it("lets any signed-in user read the sample run", async () => {
    viewer.current = B;
    const res = await getRun(new Request("http://x/api"), params({ runId: "sample" }));
    expect(res.status).toBe(200);
    expect((await res.json()).report.sample).toBe(true);
  });
  it("returns 404 for malformed ids", async () => {
    expect((await getDraft(new Request("http://x/api"), params({ draftId: "../etc" }))).status).toBe(404);
    expect((await getRun(new Request("http://x/api"), params({ runId: "run_x" }))).status).toBe(404);
  });
});

describe("PATCH scenario review", () => {
  it("accepts, rejects and edits a scenario", async () => {
    const draftId = await makeDraft();
    const find = (d: { scenarios: Array<{ scenario: { id: string; title: string }; decision: string; edited: boolean }> }) =>
      d.scenarios.find((s) => s.scenario.id === FIRST)!;

    let res = await review(draftId, FIRST, { decision: "accepted" });
    expect(res.status).toBe(200);
    expect(find((await res.json()).draft).decision).toBe("accepted");

    res = await review(draftId, FIRST, { decision: "rejected" });
    expect(find((await res.json()).draft).decision).toBe("rejected");

    res = await review(draftId, FIRST, { decision: "accepted", edits: { title: "Edited title" } });
    const row = find((await res.json()).draft);
    expect(row).toMatchObject({ decision: "accepted", edited: true });
    expect(row.scenario.title).toBe("Edited title");

    const fetched = await getDraft(new Request("http://x/api"), params({ draftId }));
    expect(find((await fetched.json()).draft).scenario.title).toBe("Edited title");
  });
  it("returns 404 for an unknown scenario", async () => {
    const draftId = await makeDraft();
    expect((await review(draftId, "sx_does_not_exist", { decision: "accepted" })).status).toBe(404);
  });
  it("returns 400 for an invalid decision", async () => {
    const draftId = await makeDraft();
    expect((await review(draftId, FIRST, { decision: "maybe" })).status).toBe(400);
  });
});

describe("POST runs + GET report", () => {
  it("returns 409 when nothing is accepted", async () => {
    const draftId = await makeDraft();
    const res = await startRun(post({}), params({ draftId }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBeTruthy();
  });
  it("runs only accepted scenarios with k trials each", async () => {
    const draftId = await makeDraft();
    await review(draftId, FIRST, { decision: "accepted" });
    const res = await startRun(post({ k: 3 }), params({ draftId }));
    expect(res.status).toBe(201);
    const { runId } = await res.json();
    expect(runId).toMatch(/^run_/);

    const report = (await (await getRun(new Request("http://x/api"), params({ runId }))).json()).report;
    expect(report.sample).toBe(true);
    expect(report.k).toBe(3);
    expect(report.scenarios.map((s: { id: string }) => s.id)).toEqual([FIRST]);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].trials).toHaveLength(3);
  });
  it("defaults k to 5 with an empty body and rejects k out of range", async () => {
    const draftId = await makeDraft();
    await review(draftId, FIRST, { decision: "accepted" });
    const res = await startRun(new Request("http://x/api", { method: "POST" }), params({ draftId }));
    expect(res.status).toBe(201);
    const { runId } = await res.json();
    const report = (await (await getRun(new Request("http://x/api"), params({ runId }))).json()).report;
    expect(report.k).toBe(5);
    expect((await startRun(post({ k: 99 }), params({ draftId }))).status).toBe(400);
  });
});

describe("SandboxInputError mapping", () => {
  it("maps a 422 with field on draft creation", async () => {
    stub.current = { createDraft: async () => { throw new SandboxInputError("bad tools", 422, "world.tools.content"); } };
    const res = await createDraft(post(intake()));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "bad tools", field: "world.tools.content" });
  });
  it("maps a 429 on draft creation", async () => {
    stub.current = { createDraft: async () => { throw new SandboxInputError("too many suites", 429); } };
    const res = await createDraft(post(intake()));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("too many suites");
  });
  it("passes a 429 from startRun through", async () => {
    stub.current = { startRun: async () => ({ ok: false, status: 429, error: "2 runs in progress" }) };
    const res = await startRun(post({}), params({ draftId: "drf_" + "0".repeat(36) }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("2 runs in progress");
  });
});
