import { describe, expect, it } from "vitest";
import { budgetAllows, pickNextAgent, readConfig, FAILURE_COOLDOWN_MS, type CandidateAgent } from "./public-agent-cron";

const H = 3_600_000;
const now = new Date("2026-11-07T12:00:00Z");
const ago = (h: number) => new Date(now.getTime() - h * H);
const agent = (slug: string, over: Partial<CandidateAgent> = {}): CandidateAgent => ({
  slug, name: slug, active: true, termsUrl: "https://example.com/terms", authorizedNote: "We operate it.", authEnvVar: "AI_GATEWAY_API_KEY", ...over,
});
const sched = (ran: Record<string, Date>, failed: Record<string, Date> = {}) => ({ lastRanAt: new Map(Object.entries(ran)), lastFailedAt: new Map(Object.entries(failed)) });

describe("pickNextAgent", () => {
  it("prefers a never-run agent over any run one", () => {
    expect(pickNextAgent([agent("a"), agent("b")], sched({ a: ago(100) }), now, 24 * H)?.slug).toBe("b");
  });
  it("picks the oldest latest-run first", () => {
    expect(pickNextAgent([agent("a"), agent("b"), agent("c")], sched({ a: ago(30), b: ago(90), c: ago(50) }), now, 24 * H)?.slug).toBe("b");
  });
  it("returns null when nothing is older than the interval", () => {
    expect(pickNextAgent([agent("a")], sched({ a: ago(23) }), now, 24 * H)).toBeNull();
    expect(pickNextAgent([agent("a")], sched({ a: ago(24) }), now, 24 * H)?.slug).toBe("a");
  });
  it("skips inactive and unauthorized agents", () => {
    const list = [agent("off", { active: false }), agent("noterms", { termsUrl: null }), agent("nonote", { authorizedNote: " " }), agent("ok")];
    expect(pickNextAgent(list, sched({ ok: ago(48) }), now, 24 * H)?.slug).toBe("ok");
    expect(pickNextAgent(list.slice(0, 3), sched({}), now, 24 * H)).toBeNull();
  });
  it("cools down an agent whose last attempt failed so it cannot starve the others", () => {
    const failed = { a: new Date(now.getTime() - FAILURE_COOLDOWN_MS / 2) };
    expect(pickNextAgent([agent("a"), agent("b")], sched({ b: ago(48) }, failed), now, 24 * H)?.slug).toBe("b");
    expect(pickNextAgent([agent("a")], sched({}, failed), now, 24 * H)).toBeNull();
  });
});

describe("owner-autopilot fields", () => {
  it("excludes non-active status and unverified owner-submitted agents; tolerates absent fields", () => {
    const list = [
      agent("paused", { status: "paused" }), agent("pending", { status: "pending_verification" }), agent("optout", { status: "opted_out" }),
      agent("unverified", { status: "active", ownerEmail: "a@b.co", verifiedAt: null }),
    ];
    expect(pickNextAgent(list, sched({}), now, 24 * H)).toBeNull();
    const ok = [...list, agent("owned", { status: "active", ownerEmail: "a@b.co", verifiedAt: ago(5) }), agent("legacy")];
    expect(pickNextAgent(ok, sched({ legacy: ago(10) }), now, 24 * H)?.slug).toBe("owned");
  });
});

describe("budget and config", () => {
  it("stops once today's spend reaches the cap", () => {
    expect(budgetAllows(2_999_999, 3_000_000)).toBe(true);
    expect(budgetAllows(3_000_000, 3_000_000)).toBe(false);
    expect(budgetAllows(5_000_000, 3_000_000)).toBe(false);
  });
  it("reads env with defaults", () => {
    expect(readConfig({})).toEqual({ minIntervalMs: 24 * H, dailyBudgetMicroUsd: 3_000_000 });
    expect(readConfig({ PUBLIC_AGENT_RERUN_HOURS: "6", PUBLIC_AGENT_DAILY_BUDGET_USD: "0.5" })).toEqual({ minIntervalMs: 6 * H, dailyBudgetMicroUsd: 500_000 });
    expect(readConfig({ PUBLIC_AGENT_RERUN_HOURS: "x", PUBLIC_AGENT_DAILY_BUDGET_USD: "" }).dailyBudgetMicroUsd).toBe(3_000_000);
  });
});
