import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = { queues: [] as unknown[][], claimGranted: true, deletes: 0, claims: [] as string[] };
  const chain = (result: () => unknown): unknown => new Proxy({}, {
    get: (_t, k) => k === "then" ? (res: (v: unknown) => unknown) => res(result()) : () => chain(result),
  });
  const table = (name: string) => new Proxy({ __t: name }, { get: (t, k) => (k === "__t" ? t.__t : `${name}.${String(k)}`) });
  return { state, chain, table };
});
vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", () => ({ and: () => ({}), asc: () => ({}), desc: () => ({}), eq: () => ({}), inArray: () => ({}), lt: () => ({}), ne: () => ({}), sql: () => ({}) }));
vi.mock("@ae/core/db/client", () => ({
  schema: Object.fromEntries(["followUps", "publicAgentRuns", "publicAgents"].map((n) => [n, h.table(n)])),
  db: () => ({
    select: () => h.chain(() => h.state.queues.shift() ?? []),
    insert: () => ({ values: (v: { kind: string }) => { h.state.claims.push(v.kind); return h.chain(() => (h.state.claimGranted ? [{ id: "f" }] : [])); } }),
    delete: () => h.chain(() => { h.state.deletes++; return []; }),
  }),
}));
vi.mock("./leaderboard-db", () => ({ getLeaderboard: async () => ({ ok: true, entries: [{ slug: "bot", rank: 1 }] }) }));
const sendOwnerEmail = vi.fn();
vi.mock("./owner-shared", () => ({ appUrl: () => "https://x", sendOwnerEmail: (i: unknown) => sendOwnerEmail(i) }));
vi.mock("./owner-policy", async (orig) => ({ ...(await orig<object>()), signToken: () => "tok" }));

import { runOwnerLifecycle } from "./owner-lifecycle";

const NOW = new Date("2026-11-07T12:00:00Z");
const DAY = 86_400_000;
const agent = { id: "a1", slug: "bot", name: "Bot", ownerEmail: "o@x.co", visibility: "public", status: "active" };
const finding = { title: "T", severity: "high", category: "ordinary" };
const run = (over = {}) => ({ run: { id: "r1", agentId: "a1", ranAt: new Date(NOW.getTime() - 60_000), passed: 20, total: 40, findings: [finding], ...over }, agent });
const opts = () => ({ now: NOW, deadline: Date.now() + 60_000 });

beforeEach(() => {
  h.state.queues = []; h.state.claimGranted = true; h.state.deletes = 0; h.state.claims = [];
  sendOwnerEmail.mockReset(); sendOwnerEmail.mockResolvedValue({ status: "sent", sent: { id: "m" } });
});

describe("runOwnerLifecycle", () => {
  it("first run sends transactional owner_results with rank, badge and CTA", async () => {
    h.state.queues = [[run()], [], []];
    const r = await runOwnerLifecycle(opts());
    expect(r.sent).toBe(1);
    const call = sendOwnerEmail.mock.calls[0]![0];
    expect(call).toMatchObject({ kind: "owner_results", transactional: true });
    expect(call.text).toContain("https://x/leaderboard/bot/badge.svg");
    expect(call.text).toContain("https://x/start");
  });

  it("private agent links to the signed owner page", async () => {
    h.state.queues = [[{ ...run(), agent: { ...agent, visibility: "private" } }], [], []];
    await runOwnerLifecycle(opts());
    expect(sendOwnerEmail.mock.calls[0]![0].text).toContain("https://x/leaderboard/owner/tok");
  });

  it("suppressed first results keep the claim (final)", async () => {
    sendOwnerEmail.mockResolvedValue({ status: "suppressed" });
    h.state.queues = [[run()], [], []];
    const r = await runOwnerLifecycle(opts());
    expect(r.sent).toBe(0); expect(h.state.deletes).toBe(0);
  });

  it("rerun with small change is claimed quiet and not emailed", async () => {
    h.state.queues = [[run({ passed: 21 })], [{ passed: 20, total: 40, findings: [finding] }], []];
    await runOwnerLifecycle(opts());
    expect(sendOwnerEmail).not.toHaveBeenCalled();
    expect(h.state.claims).toContain("owner_rerun_quiet");
  });

  it("rerun with big change sends non-transactional owner_rerun_results; capped releases the claim", async () => {
    h.state.queues = [[run({ passed: 30 })], [{ passed: 20, total: 40, findings: [finding] }], []];
    sendOwnerEmail.mockResolvedValue({ status: "capped" });
    const r = await runOwnerLifecycle(opts());
    expect(sendOwnerEmail.mock.calls[0]![0]).toMatchObject({ kind: "owner_rerun_results", transactional: false });
    expect(h.state.deletes).toBe(1); expect(r.sent).toBe(0);
  });

  it("stale capped rerun (>7d) is just marked done without emailing", async () => {
    h.state.queues = [[run({ passed: 30, ranAt: new Date(NOW.getTime() - 8 * DAY) })], [{ passed: 20, total: 40, findings: [] }], []];
    await runOwnerLifecycle(opts());
    expect(sendOwnerEmail).not.toHaveBeenCalled();
    expect(h.state.claims).toEqual(["owner_rerun_quiet"]);
  });

  it("fix offer is non-transactional and deferred (claim released) when capped", async () => {
    h.state.queues = [[], [{ agent, findings: [finding] }]];
    sendOwnerEmail.mockResolvedValue({ status: "capped" });
    const r = await runOwnerLifecycle(opts());
    expect(sendOwnerEmail.mock.calls[0]![0]).toMatchObject({ kind: "owner_fix_offer", transactional: false });
    expect(h.state.deletes).toBe(1); expect(r.sent).toBe(0);
  });

  it("fix offer is sent when allowed, skipped when no findings", async () => {
    h.state.queues = [[], [{ agent, findings: [finding] }, { agent: { ...agent, id: "a2" }, findings: [] }]];
    const r = await runOwnerLifecycle(opts());
    expect(r.sent).toBe(1); expect(sendOwnerEmail).toHaveBeenCalledTimes(1);
  });

  it("send failure releases the claim and reports an error", async () => {
    sendOwnerEmail.mockRejectedValue(new Error("boom"));
    h.state.queues = [[run()], [], []];
    const r = await runOwnerLifecycle(opts());
    expect(r.errors[0]).toContain("boom"); expect(h.state.deletes).toBe(1);
  });

  it("respects the deadline", async () => {
    h.state.queues = [[run()], [], []];
    const r = await runOwnerLifecycle({ now: NOW, deadline: Date.now() - 1 });
    expect(sendOwnerEmail).not.toHaveBeenCalled(); expect(r.processed).toBe(0);
  });
});
