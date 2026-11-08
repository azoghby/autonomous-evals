import { describe, expect, it, vi } from "vitest";

vi.mock("@ae/core/db/client", () => ({ db: () => { throw new Error("db must not be touched"); }, schema: {} }));

import { runFeedbackOutreach, type OutreachDeps, type OutreachInvite, type OutreachSendResult, type OutreachStore } from "./feedback-send";
import type { FeedbackRecipient } from "./feedback-logic";

const recipient = (i: number): FeedbackRecipient => ({
  email: `p${i}@agent${i}.dev`, name: `Person ${i}`, org: `Agent${i}`, sourceUrl: `https://agent${i}.dev/contact`,
  reason: "You maintain an open-source agent framework that people run in production.",
});

interface Row extends OutreachInvite { email: string; messageId: string | null }

/** In-memory store with the same claim semantics as the SQL (`where status='pending' returning id`). */
function memStore(seed: Row[] = []) {
  const rows = new Map(seed.map((r) => [r.id, { ...r }]));
  let seq = 0;
  const store: OutreachStore & { rows: Map<string, Row>; claims: string[] } = {
    rows, claims: [],
    async findByEmail(email) { return [...rows.values()].find((r) => r.email === email.toLowerCase()) ?? null; },
    async usedCount() { return [...rows.values()].filter((r) => ["sending", "sent", "failed", "replied"].includes(r.status) || r.sentAt).length; },
    async insertPending(r, token) {
      const hit = [...rows.values()].find((x) => x.email === r.email);
      if (hit) return hit;
      const row: Row = { id: `inv-${++seq}`, token, status: "pending", sentAt: null, email: r.email, messageId: null };
      rows.set(row.id, row);
      return row;
    },
    async claim(id) {
      store.claims.push(id);
      const r = rows.get(id);
      if (!r || r.status !== "pending") return false;
      r.status = "sending";
      return true;
    },
    async markSent(id, s) { Object.assign(rows.get(id)!, { status: "sent", messageId: s.messageId, sentAt: s.sentAt }); },
    async markFailed(id) { const r = rows.get(id)!; if (r.status === "sending") r.status = "failed"; },
    async release(id, status) { const r = rows.get(id)!; if (r.status === "sending") r.status = status; },
    async markSuppressed(id) { const r = rows.get(id)!; if (r.status === "pending") r.status = "suppressed"; },
  };
  return store;
}

function makeDeps(store: OutreachStore, over: Partial<OutreachDeps> = {}) {
  const sent: string[] = [], errors: string[] = [], previews: string[] = [], log: string[] = [];
  let tok = 0;
  const sendEmail = vi.fn(async (m: { to: string }): Promise<OutreachSendResult> => { sent.push(m.to); return { status: "sent", sent: { id: `msg-${sent.length}` } }; });
  const deps: OutreachDeps = {
    store, sendEmail, isSuppressed: async () => false, newToken: () => `tok-${++tok}`,
    appUrl: "https://standard-evals.vercel.app", companyAddress: null,
    log: (l) => log.push(l), writePreview: (f) => previews.push(f), recordSent: () => {}, recordError: (l) => errors.push(l),
    sleep: async () => {}, now: () => new Date("2026-11-08T14:00:00Z"),
    ...over,
  };
  return { deps, sendEmail, sent, errors, previews, log };
}

describe("runFeedbackOutreach", () => {
  it("dry run renders previews and never writes or sends", async () => {
    const store = memStore();
    const spy = vi.spyOn(store, "claim");
    const { deps, sendEmail, previews } = makeDeps(store);
    const s = await runFeedbackOutreach([recipient(1), recipient(2)], { send: false }, deps);
    expect(s).toMatchObject({ rendered: 2, sent: 0 });
    expect(previews).toHaveLength(2);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it("claims then sends once and records the message id", async () => {
    const store = memStore();
    const { deps, sent } = makeDeps(store);
    await runFeedbackOutreach([recipient(1)], { send: true }, deps);
    expect(sent).toEqual(["p1@agent1.dev"]);
    expect([...store.rows.values()][0]).toMatchObject({ status: "sent", messageId: "msg-1" });
  });

  it("provider accepts but our DB write fails: row ends 'failed' and a rerun does NOT email again", async () => {
    const store = memStore();
    store.markSent = async () => { throw new Error("db connection reset"); };
    const first = makeDeps(store);
    const s1 = await runFeedbackOutreach([recipient(1)], { send: true }, first.deps);
    expect(s1.failed).toBe(1);
    expect(first.sent).toHaveLength(1);
    expect([...store.rows.values()][0]!.status).toBe("failed");
    expect(first.errors.join("\n")).toContain("ACCEPTED message msg-1");

    const second = makeDeps(store);
    await runFeedbackOutreach([recipient(1)], { send: true }, second.deps);
    expect(second.sendEmail).not.toHaveBeenCalled();
  });

  it("never auto-retries 'sending' or 'failed' rows", async () => {
    const store = memStore([
      { id: "a", token: "t-a", status: "sending", sentAt: null, email: "p1@agent1.dev", messageId: null },
      { id: "b", token: "t-b", status: "failed", sentAt: null, email: "p2@agent2.dev", messageId: null },
    ]);
    const { deps, sendEmail } = makeDeps(store);
    const s = await runFeedbackOutreach([recipient(1), recipient(2)], { send: true }, deps);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(s.skipped).toBe(2);
  });

  it("a provider throw marks the row failed (not pending)", async () => {
    const store = memStore();
    const { deps } = makeDeps(store, { sendEmail: async () => { throw new Error("timeout"); } });
    await runFeedbackOutreach([recipient(1)], { send: true }, deps);
    expect([...store.rows.values()][0]!.status).toBe("failed");
  });

  it("concurrent runs: only the run that wins the claim sends", async () => {
    const store = memStore();
    const a = makeDeps(store), b = makeDeps(store);
    await Promise.all([
      runFeedbackOutreach([recipient(1), recipient(2)], { send: true }, a.deps),
      runFeedbackOutreach([recipient(1), recipient(2)], { send: true }, b.deps),
    ]);
    const all = [...a.sent, ...b.sent].sort();
    expect(all).toEqual(["p1@agent1.dev", "p2@agent2.dev"]);
  });

  it("skips when the claim is lost to another run", async () => {
    const store = memStore();
    store.claim = async () => false;
    const { deps, sendEmail } = makeDeps(store);
    await runFeedbackOutreach([recipient(1)], { send: true }, deps);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("counts sending, sent and failed rows toward the cap", async () => {
    const store = memStore([
      { id: "x1", token: "t1", status: "sending", sentAt: null, email: "x1@x.dev", messageId: null },
      { id: "x2", token: "t2", status: "failed", sentAt: null, email: "x2@x.dev", messageId: null },
      { id: "x3", token: "t3", status: "sent", sentAt: new Date(), email: "x3@x.dev", messageId: "m" },
    ]);
    const { deps, sent } = makeDeps(store, { cap: 4 });
    const s = await runFeedbackOutreach([recipient(1), recipient(2)], { send: true }, deps);
    expect(sent).toEqual(["p1@agent1.dev"]);
    expect(s.capReached).toBe(true);
  });

  it("releases a claimed row when the sender reports suppressed instead of sending", async () => {
    const store = memStore();
    const { deps } = makeDeps(store, { sendEmail: async () => ({ status: "suppressed" }) });
    await runFeedbackOutreach([recipient(1)], { send: true }, deps);
    expect([...store.rows.values()][0]!.status).toBe("suppressed");
  });

  it("skips suppressed recipients before rendering or sending", async () => {
    const store = memStore();
    const { deps, sendEmail } = makeDeps(store, { isSuppressed: async () => true });
    const s = await runFeedbackOutreach([recipient(1)], { send: true }, deps);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(s.skipped).toBe(1);
  });

  it("refuses a body with a localhost link", async () => {
    const { deps, sendEmail } = makeDeps(memStore(), { appUrl: "http://localhost:3000" });
    await expect(runFeedbackOutreach([recipient(1)], { send: true }, deps)).rejects.toThrow(/localhost/);
    const { deps: d2 } = makeDeps(memStore(), { appUrl: "http://127.0.0.1:3000" });
    await expect(runFeedbackOutreach([recipient(1)], { send: false }, d2)).rejects.toThrow(/localhost/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects duplicate recipients and lists over the cap", async () => {
    const { deps } = makeDeps(memStore(), { cap: 1 });
    await expect(runFeedbackOutreach([recipient(1), recipient(2)], { send: false }, deps)).rejects.toThrow(/cap/);
    const { deps: d2 } = makeDeps(memStore());
    await expect(runFeedbackOutreach([recipient(1), recipient(1)], { send: false }, d2)).rejects.toThrow(/duplicate/);
  });
});
