import { describe, expect, it, vi } from "vitest";
import { handleInbound, bareAddress, MAX_INBOUND_CHARS, type InboundStore } from "./inbound-email";

vi.mock("@ae/core/db/client", () => ({ db: vi.fn(), schema: {} }));
vi.mock("@/workflows/events", () => ({ sendJobEvent: vi.fn() }));

const msg = (over: Record<string, unknown> = {}) => ({
  eventType: "message.received", inboxId: "ae-commercial@agentmail.to", threadId: "t1", messageId: "m1",
  from: "Pat <Pat@Example.com>", subject: "Re: x", text: "my answer", ...over,
});

function fakeStore(opts: { thread?: { jobId: string | null; expertEngagementId: string | null } | null; state?: string; expertInvited?: boolean } = {}) {
  const seen = new Set<string>();
  const calls = { messages: [] as string[], clarifications: [] as string[], expertReplies: [] as string[] };
  const store: InboundStore = {
    claim: async (id) => (seen.has(id) ? false : (seen.add(id), true)),
    release: async (id) => { seen.delete(id); },
    findThread: async () => (opts.thread === undefined ? { jobId: "job1", expertEngagementId: null } : opts.thread),
    jobInfo: async () => ({ state: opts.state ?? "running", customerEmail: "pat@example.com" }),
    addCustomerMessage: async (_j, b) => { calls.messages.push(b); },
    expertEmail: async () => "pat@example.com",
    recordExpertReply: async (_e, raw) => { if (opts.expertInvited === false) return false; calls.expertReplies.push(raw); return true; },
    sendClarificationAnswer: async (_j, a) => { calls.clarifications.push(a); },
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
});
