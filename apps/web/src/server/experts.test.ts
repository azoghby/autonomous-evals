import { describe, expect, it } from "vitest";
import { hashToken, newToken } from "@ae/core/auth/tokens";
import { ExpertRequest, ExpertSignup, QuestionnaireAnswers } from "@ae/core/contracts/experts";
import {
  buildInviteEmail, checkEngagementToken, coldContactRateLimit, inviteBlockReason, isColdSource,
  startOfUtcDay, toPublicQuestionnaire, validateAnswerIndexes,
} from "./experts-logic";

const validSignup = {
  name: "Dana Lee", email: "dana@example.com", title: "Claims adjuster", domains: ["insurance claims"],
  availability: "evenings", consents: { contactForPaidWork: true, recordCalls: false, attributeByName: false },
};

describe("ExpertSignup", () => {
  it("accepts a valid signup", () => expect(ExpertSignup.safeParse(validSignup).success).toBe(true));
  it("requires the paid-work contact consent literal", () => {
    expect(ExpertSignup.safeParse({ ...validSignup, consents: { ...validSignup.consents, contactForPaidWork: false } }).success).toBe(false);
  });
  it("rejects 0 or more than 5 domains and non-https profile urls", () => {
    expect(ExpertSignup.safeParse({ ...validSignup, domains: [] }).success).toBe(false);
    expect(ExpertSignup.safeParse({ ...validSignup, domains: ["a1", "b1", "c1", "d1", "e1", "f1"] }).success).toBe(false);
    expect(ExpertSignup.safeParse({ ...validSignup, profileUrl: "http://x.com/me" }).success).toBe(false);
    expect(ExpertSignup.safeParse({ ...validSignup, profileUrl: "https://x.com/me" }).success).toBe(true);
  });
  it("rejects bad email", () => expect(ExpertSignup.safeParse({ ...validSignup, email: "nope" }).success).toBe(false));
});

describe("ExpertRequest / answers", () => {
  it("bounds questions 1-8", () => {
    const base = { domain: "law", purpose: "p", maxBudgetCents: 0 };
    expect(ExpertRequest.safeParse({ ...base, questions: [] }).success).toBe(false);
    expect(ExpertRequest.safeParse({ ...base, questions: Array(9).fill("q") }).success).toBe(false);
    expect(ExpertRequest.safeParse({ ...base, questions: ["q"] }).success).toBe(true);
  });
  it("caps answers at 5000 chars", () => {
    expect(QuestionnaireAnswers.safeParse({ answers: [{ questionIndex: 0, answer: "x".repeat(5001) }] }).success).toBe(false);
    expect(QuestionnaireAnswers.safeParse({ answers: [{ questionIndex: 0, answer: "x".repeat(5000) }] }).success).toBe(true);
  });
  it("rejects unknown or duplicate question indexes", () => {
    expect(validateAnswerIndexes(2, [{ questionIndex: 2 }]).ok).toBe(false);
    expect(validateAnswerIndexes(2, [{ questionIndex: 0 }, { questionIndex: 0 }]).ok).toBe(false);
    expect(validateAnswerIndexes(2, [{ questionIndex: 1 }]).ok).toBe(true);
  });
});

describe("invite policy", () => {
  const ok = { expertStatus: "active", suppressed: false, requestStatus: "open", alreadyInvited: false, committedCents: 0, honorariumCents: 2500, maxBudgetCents: 2500 };
  it("allows a clean invite", () => expect(inviteBlockReason(ok)).toBeNull());
  it("blocks suppressed addresses first", () => {
    expect(inviteBlockReason({ ...ok, suppressed: true, expertStatus: "opted_out" })).toBe("email_suppressed");
  });
  it("blocks opted-out experts, closed requests, duplicates", () => {
    expect(inviteBlockReason({ ...ok, expertStatus: "opted_out" })).toBe("expert_opted_out");
    expect(inviteBlockReason({ ...ok, requestStatus: "closed" })).toBe("request_closed");
    expect(inviteBlockReason({ ...ok, alreadyInvited: true })).toBe("already_invited");
  });
  it("blocks when honoraria would exceed the budget (default $0 budget blocks everything)", () => {
    expect(inviteBlockReason({ ...ok, committedCents: 1 })).toBe("over_budget");
    expect(inviteBlockReason({ ...ok, maxBudgetCents: 0 })).toBe("over_budget");
  });
});

describe("token lookup and validity", () => {
  const future = new Date(Date.now() + 1000), past = new Date(Date.now() - 1000);
  it("hashes deterministically and never equals the raw token", () => {
    const t = newToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(newToken())).not.toBe(hashToken(t));
  });
  it("accepts a live invited token", () => expect(checkEngagementToken({ status: "invited", expiresAt: future })).toBe("ok"));
  it("rejects unknown, expired, used and cancelled", () => {
    expect(checkEngagementToken(null)).toBe("not_found");
    expect(checkEngagementToken({ status: "invited", expiresAt: past })).toBe("expired");
    expect(checkEngagementToken({ status: "answered", expiresAt: future })).toBe("used");
    expect(checkEngagementToken({ status: "paid", expiresAt: future })).toBe("used");
    expect(checkEngagementToken({ status: "cancelled", expiresAt: future })).toBe("cancelled");
  });
});

describe("cold contact rate limit", () => {
  it("allows up to 10 per day", () => {
    expect(coldContactRateLimit(0)).toEqual({ allowed: true, remaining: 10 });
    expect(coldContactRateLimit(9)).toEqual({ allowed: true, remaining: 1 });
    expect(coldContactRateLimit(10).allowed).toBe(false);
    expect(coldContactRateLimit(25).allowed).toBe(false);
  });
  it("only agent_researched is cold", () => {
    expect(isColdSource("agent_researched")).toBe(true);
    expect(isColdSource("opt_in")).toBe(false);
    expect(isColdSource("customer_nominated")).toBe(false);
  });
  it("window starts at UTC midnight", () => {
    expect(startOfUtcDay(new Date("2026-11-07T23:59:59Z")).toISOString()).toBe("2026-11-07T00:00:00.000Z");
  });
});

describe("public questionnaire", () => {
  it("never exposes job, customer, budget or expert fields", () => {
    const request = {
      id: "r1", jobId: "11111111-1111-4111-8111-111111111111", domain: "law", purpose: "Calibrate intake tests",
      questions: ["Q1?", "Q2?"], maxBudgetCents: 9999, status: "open", customerEmail: "cust@x.com", requestedByAgentSession: "s1",
    };
    const engagement = { id: "e1", expertId: "x1", tokenHash: "abc", honorariumCents: 2500, mode: "async", expiresAt: new Date("2030-01-01") };
    const out = toPublicQuestionnaire(request, engagement);
    expect(Object.keys(out).sort()).toEqual(["domain", "expiresAt", "honorariumCents", "mode", "purpose", "questions", "status"]);
    const json = JSON.stringify(out);
    for (const secret of [request.jobId, "cust@x.com", "9999", "abc", "x1", "s1"]) expect(json).not.toContain(secret);
  });
  it("tolerates malformed questions", () => {
    expect(toPublicQuestionnaire({ domain: "d", purpose: "p", questions: "oops" }, { honorariumCents: 1, mode: "async", expiresAt: new Date() }).questions).toEqual([]);
  });
});

describe("invite email", () => {
  const mail = buildInviteEmail({
    expertName: "Dana Lee", domain: "insurance claims", purpose: "Calibrate tests", questionCount: 3, honorariumCents: 2500,
    questionnaireUrl: "https://x.test/expert/r/T", optOutUrl: "https://x.test/expert/opt-out/T", companyAddress: "1 Main St",
  });
  it("is honest and compliant", () => {
    expect(mail.body).toMatch(/written by an AI agent/);
    expect(mail.body).toContain("Autonomous Evals");
    expect(mail.body).toContain("$25");
    expect(mail.body).toContain("https://x.test/expert/opt-out/T");
    expect(mail.body).toContain("1 Main St");
    expect(mail.subject).not.toMatch(/^re:/i);
  });
});
