import { describe, expect, it, vi } from "vitest";
import { handleInbound, bareAddress, MAX_INBOUND_CHARS, type InboundStore } from "./inbound-email";

vi.mock("@ae/core/db/client", () => ({ db: vi.fn(), schema: {} }));
vi.mock("@/workflows/events", () => ({ sendJobEvent: vi.fn() }));
vi.mock("./owner-responder", () => ({ respondToOwner: vi.fn() }));
vi.mock("./notify/founder-email", () => ({ findFounderThread: vi.fn(), founderReplyDeps: vi.fn() }));

const msg = (over: Record<string, unknown> = {}) => ({
  eventType: "message.received", inboxId: "ae-commercial@agentmail.to", threadId: "t1", messageId: "m1",
  from: "Pat <Pat@Example.com>", subject: "Re: x", text: "my answer", ...over,
});

function fakeStore(opts: { thread?: { jobId: string | null; expertEngagementId: string | null; publicAgentId?: string | null } | null; owner?: { ownerEmail: string | null; verifiedAt: Date | null; status: string } | null; state?: string; expertInvited?: boolean } = {}) {
  const seen = new Set<string>();
  const calls = { ownerReplies: [] as string[], messages: [] as string[], clarifications: [] as string[], expertReplies: [] as string[] };
  const store: InboundStore = {
    claim: async (id) => (seen.has(id) ? false : (seen.add(id), true)),
    release: async (id) => { seen.delete(id); },
    findThread: async () => (opts.thread === undefined ? { jobId: "job1", expertEngagementId: null } : opts.thread),
    jobInfo: async () => ({ state: opts.state ?? "running", customerEmail: "pat@example.com" }),
    addCustomerMessage: async (_j, b) => { calls.messages.push(b); },
    expertEmail: async () => "pat@example.com",
    recordExpertReply: async (_e, raw) => { if (opts.expertInvited === false) return false; calls.expertReplies.push(raw); return true; },
    sendClarificationAnswer: async (_j, a) => { calls.clarifications.push(a); },
    ownerAgent: async () => (opts.owner === undefined ? { ownerEmail: "pat@example.com", verifiedAt: new Date(), status: "active" } : opts.owner),
    handleOwnerReply: async (i) => { calls.ownerReplies.push(i.body); return "owner_replied"; },
  };
  return { store, calls };
}

describe("handleInbound", () => {
  it("parses bare addresses", () => expect(bareAddress("Pat <Pat@Example.com>")).toBe("pat@example.com"));

  it("ignores non message.received events", async () => {
    const { store, calls } = fakeStore();
    expect(await handleInbound(msg({ eventType: "message.sent" }), store)).toBe("ignored");
    expect(calls.messages).toEqual([]);
  });

  it("stores the customer message and is idempotent on message id", async () => {
    const { store, calls } = fakeStore();
    expect(await handleInbound(msg(), store)).toBe("job_message");
    expect(await handleInbound(msg(), store)).toBe("duplicate");
    expect(calls.messages).toEqual(["my answer"]);
    expect(calls.clarifications).toEqual([]);
  });

  it("delivers a clarification_answer when the job needs clarification", async () => {
    const { store, calls } = fakeStore({ state: "needs_clarification" });
    expect(await handleInbound(msg(), store)).toBe("clarification_delivered");
    expect(calls.clarifications).toEqual(["my answer"]);
    expect(calls.messages).toEqual(["my answer"]);
  });

  it("rejects replies from a different sender than the customer", async () => {
    const { store, calls } = fakeStore({ state: "needs_clarification" });
    expect(await handleInbound(msg({ from: "evil@x.com" }), store)).toBe("sender_mismatch");
    expect(calls.messages).toEqual([]);
    expect(calls.clarifications).toEqual([]);
  });

  it("truncates oversized untrusted bodies", async () => {
    const { store, calls } = fakeStore();
    await handleInbound(msg({ text: "a".repeat(MAX_INBOUND_CHARS + 500) }), store);
    expect(calls.messages[0]).toHaveLength(MAX_INBOUND_CHARS);
  });

  it("routes expert thread replies and skips when not awaiting a reply", async () => {
    const t = { jobId: null, expertEngagementId: "eng1" };
    const a = fakeStore({ thread: t });
    expect(await handleInbound(msg(), a.store)).toBe("expert_reply");
    expect(a.calls.expertReplies).toEqual(["my answer"]);
    const b = fakeStore({ thread: t, expertInvited: false });
    expect(await handleInbound(msg(), b.store)).toBe("expert_reply_skipped");
  });

  it("returns unmatched for unknown threads", async () => {
    const { store } = fakeStore({ thread: null });
    expect(await handleInbound(msg(), store)).toBe("unmatched");
  });

  it("releases the claim when processing throws so a retry can succeed", async () => {
    const { store } = fakeStore();
    store.addCustomerMessage = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(undefined);
    await expect(handleInbound(msg(), store)).rejects.toThrow("db down");
    expect(await handleInbound(msg(), store)).toBe("job_message");
  });

  describe("owner agent threads", () => {
    const t = { jobId: null, expertEngagementId: null, publicAgentId: "agent1" };
    it("routes a verified owner's reply to the responder", async () => {
      const { store, calls } = fakeStore({ thread: t });
      expect(await handleInbound(msg(), store)).toBe("owner_replied");
      expect(calls.ownerReplies).toEqual(["my answer"]);
    });
    it("rejects an unverified owner", async () => {
      const { store, calls } = fakeStore({ thread: t, owner: { ownerEmail: "pat@example.com", verifiedAt: null, status: "pending_verification" } });
      expect(await handleInbound(msg(), store)).toBe("sender_mismatch");
      expect(calls.ownerReplies).toEqual([]);
    });
    it("rejects a sender who is not the owner", async () => {
      const { store, calls } = fakeStore({ thread: t });
      expect(await handleInbound(msg({ from: "evil@x.com" }), store)).toBe("sender_mismatch");
      expect(calls.ownerReplies).toEqual([]);
    });
    it("is unmatched when the agent no longer exists", async () => {
      const { store } = fakeStore({ thread: t, owner: null });
      expect(await handleInbound(msg(), store)).toBe("unmatched");
    });
  });
});

describe("handleInbound: founder email replies", () => {
  const founderMsg = (over: Record<string, unknown> = {}) => ({ ...msg({ from: "Ronit <Ronit@Gmail.com>", subject: "Re: [Approve #12] Outreach", text: "YES", threadId: "ft1", messageId: "fm1" }), ...over });
  function founderStore(thread: { kind: "approval" | "report"; approvalSeq: number | null } | null = { kind: "approval", approvalSeq: 12 }) {
    const { store } = fakeStore({ thread: null });
    const decisions: string[] = [];
    const deps = {
      decide: async (seq: number, d: "approve" | "reject") => { decisions.push(`${d}:${seq}`); return { ok: true, message: "ok" }; },
      approveAllDrafts: async () => ({ total: 0, sent: 0, approved: 0, skipped: 0 }),
      saveNote: async () => {}, reply: async () => {},
    };
    return { decisions, store: { ...store, founderThread: async (id: string) => (id === "ft1" ? thread : null), founderAddress: () => "ronit@gmail.com", founderReplyDeps: () => deps } as InboundStore };
  }

  it("approves from the founder on a thread we started (case-insensitive sender)", async () => {
    const { store, decisions } = founderStore();
    expect(await handleInbound(founderMsg(), store)).toBe("founder_decided");
    expect(decisions).toEqual(["approve:12"]);
  });
  it("is idempotent per message id (replayed webhook does nothing)", async () => {
    const { store, decisions } = founderStore();
    await handleInbound(founderMsg(), store);
    expect(await handleInbound(founderMsg(), store)).toBe("duplicate");
    expect(decisions).toHaveLength(1);
  });
  it("rejects a spoofed sender on a founder thread", async () => {
    const { store, decisions } = founderStore();
    expect(await handleInbound(founderMsg({ from: "evil@x.com" }), store)).toBe("sender_mismatch");
    expect(decisions).toEqual([]);
  });
  it("rejects when AgentMail reports a failing DKIM/SPF verdict", async () => {
    const { store, decisions } = founderStore();
    expect(await handleInbound(founderMsg({ auth: { dkim: "fail", spf: "pass" } }), store)).toBe("founder_unauthenticated");
    expect(decisions).toEqual([]);
  });
  it("ignores the founder address on a thread we did not start", async () => {
    const { store, decisions } = founderStore();
    expect(await handleInbound(founderMsg({ threadId: "other" }), store)).toBe("unmatched");
    expect(decisions).toEqual([]);
  });
});
