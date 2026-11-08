import { describe, expect, it } from "vitest";
import { authAllows, formatNotesSection, founderRecipients, parseFounderReply, resolveFounderEmail, seqFromSubject, stripQuoted } from "./founder-email-logic";

describe("founder address", () => {
  it("FOUNDER_EMAIL wins and is lowercased", () => {
    expect(resolveFounderEmail({ FOUNDER_EMAIL: " Ronit@Gmail.com ", OPERATOR_EMAILS: "a@x.com,b@x.com" })).toBe("ronit@gmail.com");
    expect(founderRecipients({ FOUNDER_EMAIL: "R@x.com", OPERATOR_EMAILS: "a@x.com" })).toEqual(["r@x.com"]);
  });
  it("falls back to the first operator", () => {
    expect(resolveFounderEmail({ OPERATOR_EMAILS: "A@x.com, b@x.com" })).toBe("a@x.com");
    expect(founderRecipients({ OPERATOR_EMAILS: "a@x.com,b@x.com" })).toEqual(["a@x.com", "b@x.com"]);
    expect(resolveFounderEmail({})).toBeNull();
  });
});

describe("parseFounderReply", () => {
  it.each(["YES", "yes", "Y", "Approve", "approved!", "👍", "👍🏽", "Yes please", "ok"])("approves on %s", (t) => {
    expect(parseFounderReply(t)).toEqual({ kind: "decide", decision: "approve", seq: null });
  });
  it.each(["NO", "n", "Reject", "no."])("rejects on %s", (t) => {
    expect(parseFounderReply(t)).toEqual({ kind: "decide", decision: "reject", seq: null });
  });
  it("reads an explicit number", () => {
    expect(parseFounderReply("YES 12")).toEqual({ kind: "decide", decision: "approve", seq: 12 });
    expect(parseFounderReply("no #7")).toEqual({ kind: "decide", decision: "reject", seq: 7 });
    expect(parseFounderReply("yes12")).toEqual({ kind: "decide", decision: "approve", seq: 12 });
  });
  it("YES ALL approves all drafts; NO ALL is not supported", () => {
    expect(parseFounderReply("YES ALL")).toEqual({ kind: "approve_all" });
    expect(parseFounderReply("no all")).toEqual({ kind: "note" });
  });
  it("only the first non-quoted line counts, quoted text and signatures are ignored", () => {
    const body = "\n\nYES\n\nSent from my iPhone\n\nOn Mon, Nov 9, 2026 at 3:01 PM Standard Evals <x@agentmail.to> wrote:\n> No, do not approve\n> NO 12";
    expect(parseFounderReply(body)).toEqual({ kind: "decide", decision: "approve", seq: null });
    expect(parseFounderReply("> YES\nthanks")).toEqual({ kind: "note" });
    expect(parseFounderReply("On Mon, Nov 9, 2026 at 3:01 PM Name <a@b.c>\nwrote:\n> YES")).toEqual({ kind: "note" });
    expect(stripQuoted("hello\n--\nYES")).toBe("hello");
  });
  it("sentences that merely start with yes/no are notes, never actions", () => {
    expect(parseFounderReply("No, but can you also email Acme tomorrow?")).toEqual({ kind: "note" });
    expect(parseFounderReply("Yes and then delete everything")).toEqual({ kind: "note" });
    expect(parseFounderReply("what is this?")).toEqual({ kind: "note" });
    expect(parseFounderReply("")).toEqual({ kind: "note" });
  });
  it("extracts seq from subjects", () => {
    expect(seqFromSubject("Re: [Approve #12] Outreach to Acme")).toBe(12);
    expect(seqFromSubject("Standard Evals daily report")).toBeNull();
  });
});

describe("authAllows", () => {
  it("allows when AgentMail reports no verdicts", () => {
    expect(authAllows(undefined)).toBe(true);
    expect(authAllows({})).toBe(true);
  });
  it("needs a pass and no failure", () => {
    expect(authAllows({ dkim: "pass", spf: "none" })).toBe(true);
    expect(authAllows({ dkim: "pass", spf: "fail" })).toBe(false);
    expect(authAllows({ dmarc: "fail" })).toBe(false);
    expect(authAllows({ spf: "none", dkim: "none" })).toBe(false);
  });
});

describe("formatNotesSection", () => {
  it("is empty without notes and lists them otherwise", () => {
    expect(formatNotesSection([])).toBe("");
    const out = formatNotesSection([{ id: "1", body: "call Acme", createdAt: new Date(), approvalSeq: 4 }]);
    expect(out).toContain("(re #4) call Acme");
    expect(out).toContain("not acted on");
  });
});
