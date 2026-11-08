import { describe, expect, it } from "vitest";
import {
  NON_TRANSACTIONAL_GAP_MS, canSendNonTransactional, decideOwnerEmail, rerunWorthEmailing, signToken, verifySignedToken,
  unsubscribeToken, ownerFooter, SENDER_LINE, ipHash,
} from "./owner-policy";

const env = { SESSION_SECRET: "test-secret-for-owner-policy" };
const now = new Date("2026-11-07T12:00:00Z");

describe("non-transactional cadence cap", () => {
  it("allows when nothing was sent, blocks within 3 days, allows after", () => {
    expect(canSendNonTransactional(null, now)).toBe(true);
    expect(canSendNonTransactional(new Date(now.getTime() - NON_TRANSACTIONAL_GAP_MS + 60_000), now)).toBe(false);
    expect(canSendNonTransactional(new Date(now.getTime() - NON_TRANSACTIONAL_GAP_MS), now)).toBe(true);
  });
  it("transactional mail ignores the cap; suppression blocks everything but direct replies", () => {
    const recent = new Date(now.getTime() - 1000);
    expect(decideOwnerEmail({ transactional: true, suppressed: false, lastNonTransactionalAt: recent, now })).toBe("send");
    expect(decideOwnerEmail({ transactional: false, suppressed: false, lastNonTransactionalAt: recent, now })).toBe("capped");
    expect(decideOwnerEmail({ transactional: true, suppressed: true, lastNonTransactionalAt: null, now })).toBe("suppressed");
    expect(decideOwnerEmail({ transactional: true, suppressed: true, isDirectReply: true, lastNonTransactionalAt: null, now })).toBe("send");
  });
});

describe("re-run notification rule", () => {
  const base = { passed: 20, total: 32, findings: [{ title: "Leaks prompt", severity: "high", scenarioId: "rt-1" }] };
  it("is quiet for small changes and no new high findings", () => {
    expect(rerunWorthEmailing(base, { ...base, passed: 21 }).notify).toBe(false);
  });
  it("notifies on a >= 5 point move either way", () => {
    expect(rerunWorthEmailing(base, { ...base, passed: 22 }).notify).toBe(true); // +6.25
    expect(rerunWorthEmailing(base, { ...base, passed: 18 }).notify).toBe(true);
  });
  it("notifies on a new high/critical finding only", () => {
    const next = { ...base, findings: [...base.findings, { title: "Injection", severity: "critical", scenarioId: "rt-2" }, { title: "Tone", severity: "low", scenarioId: "x" }] };
    expect(rerunWorthEmailing(base, next)).toMatchObject({ notify: true, newHigh: ["Injection"] });
  });
});

describe("signed tokens", () => {
  it("round-trips and is bound to its purpose", () => {
    const t = signToken("approve_all", { ids: ["a"], op: "o@x.com" }, env);
    expect(verifySignedToken("approve_all", t, env)).toEqual({ ids: ["a"], op: "o@x.com" });
    expect(verifySignedToken("unsubscribe", t, env)).toBeNull();
  });
  it("rejects tampering, wrong secret and expiry", () => {
    const t = signToken("approve_all", { ids: ["a"], exp: now.getTime() + 1000 }, env);
    const [body, sig] = t.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ids: ["a", "b"], exp: now.getTime() + 1000 })).toString("base64url")}.${sig}`;
    expect(verifySignedToken("approve_all", forged, env, now.getTime())).toBeNull();
    expect(verifySignedToken("approve_all", `${body}.${sig}`, { SESSION_SECRET: "other" }, now.getTime())).toBeNull();
    expect(verifySignedToken("approve_all", t, env, now.getTime() + 2000)).toBeNull();
    expect(verifySignedToken("approve_all", "garbage", env)).toBeNull();
  });
  it("unsubscribe tokens normalize the address", () => {
    expect(verifySignedToken("unsubscribe", unsubscribeToken(" Owner@Example.COM ", env), env)).toEqual({ e: "owner@example.com" });
  });
});

describe("footer and ip hash", () => {
  it("footer carries sender identity, unsubscribe link and address", () => {
    const f = ownerFooter({ agentName: "Bot", unsubscribeUrl: "https://u/x", companyAddress: "1 Main St" });
    expect(f).toContain(SENDER_LINE);
    expect(f).toContain("https://u/x");
    expect(f).toContain("1 Main St");
  });
  it("ip hash never contains the raw ip", () => {
    const h = ipHash("203.0.113.7", env);
    expect(h).not.toContain("203.0.113.7");
    expect(h).toHaveLength(32);
  });
});
