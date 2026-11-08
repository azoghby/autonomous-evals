import { beforeEach, describe, expect, it, vi } from "vitest";

const approve = vi.fn();
vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", () => ({ and: () => ({}), eq: () => ({}) }));
vi.mock("@ae/core/db/client", () => ({ db: () => ({}), schema: { salesLeads: {} } }));
vi.mock("../company/approval-handlers", () => ({}));
vi.mock("../outreach-approve", () => ({ approveAndSendDraft: (...a: unknown[]) => approve(...a), rejectDraft: vi.fn() }));

import { getApprovalHandler } from "./registry";
import "./handlers";

const ctx = {
  approval: { id: "a1", seq: 7, kind: "outreach_draft", title: "t", summary: "", ref: "d1", payload: {} },
  decision: "approve" as const, via: "telegram" as const, actor: "f@x.io",
};

describe("outreach_draft approval handler", () => {
  beforeEach(() => approve.mockReset());
  const run = () => getApprovalHandler("outreach_draft")!.onDecision(ctx);

  it("asks for an idempotent approve (re-send approved, ok when sent)", async () => {
    approve.mockResolvedValueOnce({ ok: true, status: "sent" });
    expect(await run()).toMatchObject({ ok: true });
    expect(approve).toHaveBeenCalledWith("d1", "f@x.io", { syncApproval: false, resendApproved: true });
  });

  it("keeps the decision when the draft was approved but the send failed", async () => {
    approve.mockResolvedValueOnce({ ok: true, status: "approved", sendError: "smtp down" });
    expect(await run()).toMatchObject({ ok: false, revert: false });
  });

  it("reverts only while the draft is still pending", async () => {
    approve.mockResolvedValueOnce({ ok: false, status: 429, error: "Daily cold-contact limit reached" });
    expect(await run()).toMatchObject({ ok: false, revert: true });
    approve.mockResolvedValueOnce({ ok: false, status: 409, error: "Draft is already rejected", draftStatus: "rejected" });
    expect(await run()).toMatchObject({ ok: false, revert: false });
    approve.mockResolvedValueOnce({ ok: false, status: 404, error: "Draft not found", draftStatus: null });
    expect(await run()).toMatchObject({ ok: false, revert: false });
  });
});
