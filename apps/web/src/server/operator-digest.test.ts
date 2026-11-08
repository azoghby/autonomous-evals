import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = { drafts: [] as unknown[], claimed: new Set<string>(), deletes: 0, sendFails: false };
  const chain = (result: () => unknown): unknown => new Proxy({}, {
    get: (_t, k) => k === "then" ? (res: (v: unknown) => unknown) => res(result()) : () => chain(result),
  });
  return { state, chain };
});
vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", () => ({ and: () => ({}), desc: () => ({}), eq: () => ({}) }));
vi.mock("@ae/core/db/client", () => {
  const t = new Proxy({}, { get: (_x, k) => String(k) });
  return {
    schema: { outreachDrafts: t, followUps: t },
    db: () => ({
      select: () => h.chain(() => h.state.drafts),
      insert: () => ({ values: (v: { subjectId: string }) => ({ onConflictDoNothing: () => ({ returning: async () => {
        if (h.state.claimed.has(v.subjectId)) return [];
        h.state.claimed.add(v.subjectId); return [{ id: "f" }];
      } }) }) }),
      delete: () => h.chain(() => { h.state.deletes++; h.state.claimed.clear(); return []; }),
    }),
  };
});
const sendEmail = vi.fn(async (_m: { to: string; text: string; purpose?: string }) => {
  if (h.state.sendFails) throw new Error("boom");
  return { id: "m" };
});
vi.mock("@ae/core/auth/email", () => ({ isEmailConfigured: () => true, sendEmail: (m: never) => sendEmail(m) }));
vi.mock("./owner-shared", () => ({ appUrl: () => "https://app.test" }));

import { buildDigestEmail, digestClaimId, runOperatorDigest, type DigestPlan } from "./operator-digest";
import { verifySignedToken } from "./owner-policy";

const NOW = new Date("2026-06-10T12:00:00Z");
const A = "11111111-1111-4111-8111-111111111111";
const draft = { id: A, kind: "agent_invite", toEmail: "x@y.com", subject: "Hi", createdAt: NOW };

beforeEach(() => {
  Object.assign(h.state, { drafts: [draft], deletes: 0, sendFails: false }); h.state.claimed.clear(); sendEmail.mockClear();
  process.env.SESSION_SECRET = "test-secret"; process.env.OPERATOR_EMAILS = "op1@example.com,op2@example.com";
});

const PLAN: DigestPlan = { summary: "Grow the funnel.", tasks: [{ assignee: "prospecting", title: "Find leads", status: "done" }] };
const noPlan = { loadPlan: async () => null };
const withPlan = { loadPlan: async () => PLAN };

const tokenFrom = (text: string) => decodeURIComponent(/approve-all\?t=(\S+)/.exec(text)![1]);

describe("runOperatorDigest", () => {
  it("does nothing and does not claim when no drafts are pending", async () => {
    h.state.drafts = [];
    expect(await runOperatorDigest(NOW, noPlan)).toEqual({ sent: false, pending: 0, reason: "none" });
    expect(sendEmail).not.toHaveBeenCalled(); expect(h.state.claimed.size).toBe(0);
  });
  it("emails every operator a per-operator approve_all token limited to the listed ids", async () => {
    expect(await runOperatorDigest(NOW, noPlan)).toEqual({ sent: true, pending: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const calls = sendEmail.mock.calls.map((c) => c[0]);
    expect(calls.every((m) => m.purpose === "auth")).toBe(true);
    for (const m of calls) {
      const t = tokenFrom(m.text);
      const p = verifySignedToken<{ ids: string[]; op: string; exp: number }>("approve_all", t, process.env, NOW.getTime());
      expect(p).toMatchObject({ ids: [A], op: m.to });
      expect(verifySignedToken("unsubscribe", t, process.env, NOW.getTime())).toBeNull();
      expect(verifySignedToken("approve_all", t, process.env, NOW.getTime() + 25 * 3600_000)).toBeNull();
    }
  });
  it("claims once per UTC day", async () => {
    await runOperatorDigest(NOW, noPlan);
    sendEmail.mockClear();
    expect(await runOperatorDigest(new Date("2026-06-10T23:00:00Z"), noPlan)).toMatchObject({ sent: false, reason: "already_sent" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await runOperatorDigest(new Date("2026-06-11T08:00:00Z"), noPlan)).toMatchObject({ sent: true });
  });
  it("releases the claim when every send fails", async () => {
    h.state.sendFails = true;
    expect(await runOperatorDigest(NOW, noPlan)).toMatchObject({ sent: false, reason: "send_failed" });
    expect(h.state.deletes).toBe(1);
    h.state.sendFails = false;
    expect(await runOperatorDigest(NOW, noPlan)).toMatchObject({ sent: true });
  });
  it("waits (without claiming) for the plan before 07:00 UTC, then sends regardless", async () => {
    const early = new Date("2026-06-10T00:00:00Z");
    expect(await runOperatorDigest(early, noPlan)).toEqual({ sent: false, pending: 1, reason: "waiting_for_plan" });
    expect(h.state.claimed.size).toBe(0); expect(sendEmail).not.toHaveBeenCalled();
    expect(await runOperatorDigest(new Date("2026-06-10T07:00:00Z"), noPlan)).toMatchObject({ sent: true });
  });
  it("sends early when the plan exists and includes it in the email", async () => {
    expect(await runOperatorDigest(new Date("2026-06-10T00:30:00Z"), withPlan)).toEqual({ sent: true, pending: 1 });
    expect(sendEmail.mock.calls[0][0].text).toContain("Today's plan (CEO agent)");
  });
  it("still sends when there are no drafts but a plan exists (no approve link)", async () => {
    h.state.drafts = [];
    expect(await runOperatorDigest(NOW, withPlan)).toEqual({ sent: true, pending: 0 });
    const text = sendEmail.mock.calls[0][0].text;
    expect(text).toContain("Find leads"); expect(text).not.toContain("approve-all");
  });
  it("buildDigestEmail adds the plan section only when given a plan", () => {
    const d = [{ ...draft }];
    expect(buildDigestEmail(d, 1, "https://u").text).not.toContain("CEO agent");
    const t = buildDigestEmail(d, 1, "https://u", PLAN).text;
    expect(t).toContain("Today's plan (CEO agent)"); expect(t).toContain("- [done] prospecting: Find leads");
    expect(buildDigestEmail([], 0, "", PLAN).subject).toMatch(/plan/i);
  });
  it("derives a uuid-shaped deterministic claim id", () => {
    expect(digestClaimId(NOW)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(digestClaimId(NOW)).toBe(digestClaimId(new Date("2026-06-10T01:00:00Z")));
  });
});
