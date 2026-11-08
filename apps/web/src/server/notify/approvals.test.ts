import { beforeEach, describe, expect, it, vi } from "vitest";

/** One founder_approvals row in memory; update().set().where() applies when the row's status matches the guard. */
const h = vi.hoisted(() => {
  const row = {
    id: "a1", seq: 7, kind: "outreach_draft", ref: "d1", title: "Invite", summary: "", status: "pending", payload: {},
    expiresAt: new Date(Date.now() + 3_600_000), decidedVia: null as string | null, decidedBy: null as string | null,
    decidedAt: null as Date | null, result: null as string | null, channelRefs: null, createdAt: new Date(),
  };
  return { row, handler: vi.fn() };
});

vi.mock("drizzle-orm", () => ({
  and: (...c: Array<{ status?: string }>) => Object.assign({}, ...c),
  eq: (col: string, v: unknown) => (col === "status" ? { status: v } : {}),
  desc: () => ({}), lt: () => ({}),
}));
vi.mock("@ae/core/db/client", () => ({
  schema: { founderApprovals: { id: "id", seq: "seq", status: "status" }, interventions: {} },
  db: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ ...h.row }] }) }) }),
    update: () => ({ set: (patch: Record<string, unknown>) => ({ where: (w: { status?: string }) => {
      const apply = () => { if (w.status === undefined || w.status === h.row.status) { Object.assign(h.row, patch); return [{ ...h.row }]; } return []; };
      const p = Promise.resolve().then(apply);
      return Object.assign(p, { returning: () => p });
    } }) }),
    insert: () => ({ values: () => Promise.resolve() }),
  }),
}));
vi.mock("./registry", () => ({ getApprovalHandler: () => ({ onDecision: h.handler }), KIND_RE: /^[a-z_]+$/ }));
vi.mock("./handlers", () => ({}));
vi.mock("./channels", () => ({ dispatchApproval: vi.fn() }));
vi.mock("./telegram", () => ({ markTelegramDecided: vi.fn(), telegramConfigured: () => false }));
vi.mock("../operator-alerts", () => ({ redactAlertText: (s: string) => s }));
vi.mock("../owner-shared", () => ({ appUrl: () => "http://x" }));

import { decideApproval } from "./approvals";

describe("decideApproval", () => {
  beforeEach(() => { Object.assign(h.row, { status: "pending", decidedVia: null, decidedBy: null, decidedAt: null, result: null }); h.handler.mockReset(); });

  it("reverts to pending (keeping the error) when the handler throws, so it can be retried", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.handler.mockRejectedValueOnce(new Error("smtp down"));
    const r = await decideApproval({ seq: 7, decision: "approve", via: "email_reply", actor: "f@x.io" });
    expect(r).toMatchObject({ ok: false, changed: false, status: "pending" });
    expect(h.row).toMatchObject({ status: "pending", decidedVia: null, decidedBy: null, decidedAt: null });
    expect(h.row.result).toMatch(/^error: Handler failed: smtp down/);

    h.handler.mockResolvedValueOnce({ ok: true, note: "Approved and sent #7." });
    expect(await decideApproval({ seq: 7, decision: "approve", via: "email_reply", actor: "f@x.io" })).toMatchObject({ ok: true, changed: true, status: "approved" });
    expect(h.row.status).toBe("approved");
    err.mockRestore();
  });

  it("reverts when the handler reports failure", async () => {
    h.handler.mockResolvedValueOnce({ ok: false, note: "Daily cap reached" });
    expect(await decideApproval({ seq: 7, decision: "approve", via: "console", actor: "f@x.io" })).toMatchObject({ ok: false, status: "pending" });
    expect(h.row.status).toBe("pending");
  });

  it("keeps a successful decision", async () => {
    h.handler.mockResolvedValueOnce({ ok: true, note: "Rejected #7; nothing was sent." });
    expect(await decideApproval({ seq: 7, decision: "reject", via: "console", actor: "f@x.io" })).toMatchObject({ ok: true, changed: true, status: "rejected" });
    expect(h.row).toMatchObject({ status: "rejected", decidedBy: "f@x.io", result: "Rejected #7; nothing was sent." });
  });
});
