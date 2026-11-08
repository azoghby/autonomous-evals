import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = { suppressed: false, dup: false, inserted: [] as unknown[] };
  const chain = (result: () => unknown): unknown => new Proxy({}, {
    get: (_t, k) => k === "then" ? (res: (v: unknown) => unknown) => res(result()) : () => chain(result),
  });
  return { state, chain };
});
vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", () => ({ and: () => ({}), eq: () => ({}), gt: () => ({}), inArray: () => ({}), sql: () => ({}) }));
vi.mock("@ae/core/db/client", () => {
  const t = new Proxy({}, { get: (_x, k) => String(k) });
  return {
    schema: { outreachDrafts: t },
    db: () => ({
      select: () => h.chain(() => (h.state.dup ? [{ id: "d" }] : [])),
      insert: () => ({ values: (v: unknown) => { h.state.inserted.push(v); return h.chain(() => [{ id: "new-id" }]); } }),
    }),
  };
});
vi.mock("./owner-shared", () => ({
  isSuppressed: async () => h.state.suppressed, appUrl: () => "https://app.test", companyAddress: () => "1 Main St",
}));
const sendEmail = vi.fn();
vi.mock("@ae/core/auth/email", () => ({ sendEmail: (m: unknown) => sendEmail(m) }));

import { buildAgentInvite, draftAgentInvite } from "./agent-invites";

const input = { toEmail: " Founder@Acme.AI ", agentName: "AcmeBot", vendor: "Acme" };
beforeEach(() => { Object.assign(h.state, { suppressed: false, dup: false, inserted: [] }); sendEmail.mockClear(); });

describe("draftAgentInvite", () => {
  it("inserts a pending agent_invite draft with a lowercased address and never sends", async () => {
    expect(await draftAgentInvite(input)).toEqual({ status: "drafted", id: "new-id" });
    expect(h.state.inserted[0]).toMatchObject({ toEmail: "founder@acme.ai", kind: "agent_invite", status: "pending" });
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("skips suppressed addresses", async () => {
    h.state.suppressed = true;
    expect(await draftAgentInvite(input)).toEqual({ status: "suppressed" });
    expect(h.state.inserted).toHaveLength(0);
  });
  it("skips duplicates", async () => {
    h.state.dup = true;
    expect(await draftAgentInvite(input)).toEqual({ status: "duplicate" });
    expect(h.state.inserted).toHaveLength(0);
  });
});

describe("buildAgentInvite", () => {
  it("is honest about identity, offer, consent, opt-out and address", () => {
    const { body } = buildAgentInvite({ ...input, note: "Saw your launch." });
    expect(body).toContain("Standard Evals' AI agents");
    expect(body).toContain("approved it");
    expect(body).toContain("we have not tested your agent");
    expect(body).toContain("https://app.test/leaderboard/submit");
    expect(body).toContain("reply 'no thanks' and we'll never email again");
    expect(body).toContain("1 Main St");
    expect(body).toContain("Saw your launch.");
  });
});
