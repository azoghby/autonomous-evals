import { describe, expect, it, vi } from "vitest";
import { processFounderReply, type FounderReplyDeps, type FounderReplyInput } from "./founder-email-reply";

function deps() {
  const d = {
    decide: vi.fn(async (seq: number, decision: "approve" | "reject") => ({ ok: true, message: `${decision === "approve" ? "Approved" : "Rejected"} #${seq}.` })),
    approveAllDrafts: vi.fn(async () => ({ total: 3, sent: 2, approved: 0, skipped: 1 })),
    saveNote: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
  return d satisfies FounderReplyDeps;
}
const input = (text: string, over: Partial<FounderReplyInput> = {}): FounderReplyInput => ({
  threadId: "t1", messageId: "m1", subject: "Re: [Approve #12] Outreach", text, thread: { kind: "approval", approvalSeq: 12 }, ...over,
});

describe("processFounderReply", () => {
  it("approves the thread's approval on a bare YES and confirms", async () => {
    const d = deps();
    expect(await processFounderReply(input("YES\n> old"), d)).toBe("decided");
    expect(d.decide).toHaveBeenCalledWith(12, "approve");
    expect(d.reply).toHaveBeenCalledWith("Approved #12.");
  });
  it("an explicit number overrides the thread; NO rejects", async () => {
    const d = deps();
    await processFounderReply(input("NO 9"), d);
    expect(d.decide).toHaveBeenCalledWith(9, "reject");
  });
  it("falls back to the subject number when the thread row has none", async () => {
    const d = deps();
    await processFounderReply(input("yes", { thread: { kind: "approval", approvalSeq: null } }), d);
    expect(d.decide).toHaveBeenCalledWith(12, "approve");
  });
  it("a bare YES on the report thread decides nothing", async () => {
    const d = deps();
    const r = await processFounderReply(input("YES", { subject: "Re: Standard Evals daily report", thread: { kind: "report", approvalSeq: null } }), d);
    expect(r).toBe("no_target");
    expect(d.decide).not.toHaveBeenCalled();
  });
  it("YES ALL runs approve-all", async () => {
    const d = deps();
    expect(await processFounderReply(input("YES ALL", { thread: { kind: "report", approvalSeq: null } }), d)).toBe("approved_all");
    expect(d.approveAllDrafts).toHaveBeenCalledTimes(1);
    expect(d.reply).toHaveBeenCalledWith(expect.stringContaining("Approved 3 draft(s): 2 sent"));
  });
  it("free text is stored as a note, never acted on, and gets the help reply", async () => {
    const d = deps();
    expect(await processFounderReply(input("Can you also email Acme tomorrow?\n> quoted"), d)).toBe("note");
    expect(d.decide).not.toHaveBeenCalled();
    expect(d.approveAllDrafts).not.toHaveBeenCalled();
    expect(d.saveNote).toHaveBeenCalledWith({ body: "Can you also email Acme tomorrow?", threadId: "t1", messageId: "m1", approvalSeq: 12 });
    expect(d.reply).toHaveBeenCalledWith(expect.stringContaining("saved it as a note"));
  });
});
