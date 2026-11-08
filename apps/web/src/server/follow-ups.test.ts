import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    queues: [] as unknown[][], // results of select() on non-suppression tables, in call order
    suppressed: false, claimGranted: true, rotated: [{ id: "x" }] as unknown[],
    deletes: 0, updates: [] as unknown[], emailConfigured: true,
  };
  const chain = (result: () => unknown): unknown => new Proxy({}, {
    get: (_t, k) => k === "then" ? (res: (v: unknown) => unknown) => res(result()) : () => chain(result),
  });
  const table = (name: string) => new Proxy({ __t: name }, { get: (t, k) => (k === "__t" ? t.__t : `${name}.${String(k)}`) });
  return { state, chain, table };
});

vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", () => ({ and: () => ({}), asc: () => ({}), eq: () => ({}), inArray: () => ({}), isNull: () => ({}), lt: () => ({}), ne: () => ({}), sql: () => ({}) }));
vi.mock("@ae/core/db/client", () => {
  const schema = Object.fromEntries(["jobs", "customers", "messages", "quotes", "followUps", "monitoringSubscriptions",
    "expertEngagements", "expertRequests", "experts", "outreachDrafts", "contactSuppressions"].map((n) => [n, h.table(n)]));
  return {
    schema,
    db: () => ({
      select: () => ({ from: (t: { __t: string }) => h.chain(() =>
        t.__t === "contactSuppressions" ? (h.state.suppressed ? [{ id: "s" }] : []) : (h.state.queues.shift() ?? [])) }),
      insert: () => h.chain(() => (h.state.claimGranted ? [{ id: "f1" }] : [])),
      update: () => h.chain(() => { h.state.updates.push(1); return h.state.rotated; }),
      delete: () => h.chain(() => { h.state.deletes++; return []; }),
    }),
  };
});
const sendEmail = vi.fn();
vi.mock("@ae/core/auth/email", () => ({ isEmailConfigured: () => h.state.emailConfigured, sendEmail: (m: unknown) => sendEmail(m) }));
const addMessage = vi.fn(async () => "m1");
vi.mock("./job-store", () => ({ addMessage: (...a: unknown[]) => addMessage(...(a as [])) }));
const recordEmailThread = vi.fn(async () => undefined);
vi.mock("./email-threads", () => ({ recordEmailThread: (...a: unknown[]) => recordEmailThread(...(a as [])) }));
vi.mock("./owner-lifecycle", () => ({ runOwnerLifecycle: async () => ({ processed: 0, sent: 0, skipped: 0, errors: [] }) }));
vi.mock("./operator-digest", () => ({ runOperatorDigest: async () => ({ sent: false, pending: 0 }) }));

import {
  buildMonitoringPitch, clarificationNudgeDue, expertReminderDue, jobEmailAllowed, monitoringPitchDue,
  quoteReminderDue, runFollowUps, formatMonthlyPrice,
} from "./follow-ups";

const NOW = new Date("2026-06-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000, HOUR = 3_600_000;

describe("clarificationNudgeDue", () => {
  const j = (over = {}) => ({ state: "needs_clarification", updatedAt: ago(10 * HOUR), lastCustomerAt: null, lastCommercialAt: null, ...over });
  it("is not due at 59 minutes, due at 61", () => {
    expect(clarificationNudgeDue(j({ lastCustomerAt: ago(59 * MIN) }), NOW)).toBe(false);
    expect(clarificationNudgeDue(j({ lastCustomerAt: ago(61 * MIN) }), NOW)).toBe(true);
  });
  it("uses the most recent of customer message and commercial question", () => {
    expect(clarificationNudgeDue(j({ lastCustomerAt: ago(5 * HOUR), lastCommercialAt: ago(30 * MIN) }), NOW)).toBe(false);
    expect(clarificationNudgeDue(j({ lastCustomerAt: ago(30 * MIN), lastCommercialAt: ago(5 * HOUR) }), NOW)).toBe(false);
  });
  it("falls back to updatedAt when there are no messages", () => {
    expect(clarificationNudgeDue(j({ updatedAt: ago(59 * MIN) }), NOW)).toBe(false);
    expect(clarificationNudgeDue(j({ updatedAt: ago(61 * MIN) }), NOW)).toBe(true);
  });
  it("ignores other states", () => expect(clarificationNudgeDue(j({ state: "quoted" }), NOW)).toBe(false));
});

describe("quoteReminderDue", () => {
  const j = (over = {}) => ({ state: "quoted", updatedAt: ago(10 * HOUR), latestQuoteAt: ago(10 * HOUR), ...over });
  it("boundary 2.9h vs 3.1h", () => {
    expect(quoteReminderDue(j({ updatedAt: ago(2.9 * HOUR), latestQuoteAt: ago(2.9 * HOUR) }), NOW)).toBe(false);
    expect(quoteReminderDue(j({ updatedAt: ago(3.1 * HOUR), latestQuoteAt: ago(3.1 * HOUR) }), NOW)).toBe(true);
  });
  it("uses the later of quote and updatedAt", () => {
    expect(quoteReminderDue(j({ state: "awaiting_payment", updatedAt: ago(1 * HOUR) }), NOW)).toBe(false);
    expect(quoteReminderDue(j({ latestQuoteAt: ago(1 * HOUR) }), NOW)).toBe(false);
  });
  it("applies to quoted and awaiting_payment only", () => {
    expect(quoteReminderDue(j({ state: "awaiting_payment" }), NOW)).toBe(true);
    expect(quoteReminderDue(j({ state: "running" }), NOW)).toBe(false);
  });
});

describe("monitoringPitchDue", () => {
  const j = (over = {}) => ({ state: "delivered", package: "text_eval", environment: "live", deliveredAt: ago(25 * HOUR), hasSubscription: false, ...over });
  it("23h vs 25h", () => {
    expect(monitoringPitchDue(j({ deliveredAt: ago(23 * HOUR) }), NOW, {})).toBe(false);
    expect(monitoringPitchDue(j(), NOW, {})).toBe(true);
  });
  it("gates on environment unless MONITORING_PITCH_TEST=1", () => {
    expect(monitoringPitchDue(j({ environment: "test" }), NOW, {})).toBe(false);
    expect(monitoringPitchDue(j({ environment: "test" }), NOW, { MONITORING_PITCH_TEST: "1" })).toBe(true);
  });
  it("skips existing subscriptions and trace_audit jobs", () => {
    expect(monitoringPitchDue(j({ hasSubscription: true }), NOW, {})).toBe(false);
    expect(monitoringPitchDue(j({ package: "trace_audit" }), NOW, {})).toBe(false);
  });
  it("formats the price from the constant", () => {
    expect(formatMonthlyPrice(4900)).toBe("$49/month");
    expect(buildMonitoringPitch("Pat Lee", "https://x/jobs/1").text).toContain("$49/month");
  });
});

describe("expertReminderDue", () => {
  const e = (over = {}) => ({ status: "invited", invitedAt: ago(25 * HOUR), expiresAt: new Date(NOW.getTime() + HOUR), expertStatus: "active", ...over });
  it("23h vs 25h", () => {
    expect(expertReminderDue(e({ invitedAt: ago(23 * HOUR) }), NOW)).toBe(false);
    expect(expertReminderDue(e(), NOW)).toBe(true);
  });
  it("skips expired, answered and opted-out", () => {
    expect(expertReminderDue(e({ expiresAt: ago(HOUR) }), NOW)).toBe(false);
    expect(expertReminderDue(e({ status: "answered" }), NOW)).toBe(false);
    expect(expertReminderDue(e({ expertStatus: "opted_out" }), NOW)).toBe(false);
  });
});

describe("jobEmailAllowed", () => {
  it("blocks mock jobs and fixtures unless FOLLOWUPS_INCLUDE_MOCK=1", () => {
    expect(jobEmailAllowed({ isMock: true, isInternalFixture: false }, {})).toBe(false);
    expect(jobEmailAllowed({ isMock: false, isInternalFixture: true }, {})).toBe(false);
    expect(jobEmailAllowed({ isMock: false, isInternalFixture: false }, {})).toBe(true);
    expect(jobEmailAllowed({ isMock: true, isInternalFixture: true }, { FOLLOWUPS_INCLUDE_MOCK: "1" })).toBe(true);
  });
});

// ---- runFollowUps with a faked db ------------------------------------------------------------------

const jobRow = (over = {}) => ({
  id: "11111111-1111-1111-1111-111111111111", state: "needs_clarification", package: "text_eval", environment: "live",
  isMock: false, isInternalFixture: false, updatedAt: ago(5 * HOUR), deliveredAt: null, email: "pat@example.com", name: "Pat Lee",
  lastCustomerAt: ago(2 * HOUR), lastCommercialAt: null, latestQuoteAt: null, hasSubscription: false, ...over,
});
const expertRow = (over = {}) => ({
  id: "22222222-2222-2222-2222-222222222222", status: "invited", expiresAt: new Date(NOW.getTime() + 5 * HOUR), invitedAt: ago(30 * HOUR),
  tokenHash: "oldhash", expertEmail: "Dana@Example.com", expertName: "Dana Lee", expertStatus: "active", domain: "insurance", ...over,
});
/** Queue order: clarification, quote, pitch, expert. */
const queue = (clar: unknown[] = [], quote: unknown[] = [], pitch: unknown[] = [], expert: unknown[] = []) => {
  h.state.queues = [clar, quote, pitch, expert];
};

beforeEach(() => {
  Object.assign(h.state, { queues: [], suppressed: false, claimGranted: true, rotated: [{ id: "x" }], deletes: 0, updates: [], emailConfigured: true });
  sendEmail.mockReset().mockResolvedValue({ id: "msg1", threadId: "th1" });
  addMessage.mockClear(); recordEmailThread.mockClear();
  delete process.env.FOLLOWUPS_INCLUDE_MOCK;
  process.env.APP_URL = "https://app.example.com";
});

describe("runFollowUps", () => {
  it("sends a nudge, records the message and thread", async () => {
    queue([jobRow()]);
    const r = await runFollowUps({ now: NOW });
    expect(r).toMatchObject({ processed: 1, sent: 1, skipped: 0, errors: [] });
    const mail = sendEmail.mock.calls[0]![0];
    expect(mail).toMatchObject({ to: "pat@example.com", purpose: "commercial" });
    expect(mail.text).toContain("https://app.example.com/jobs/11111111-1111-1111-1111-111111111111");
    expect(addMessage).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", "commercial", expect.any(String));
    expect(recordEmailThread).toHaveBeenCalledWith("th1", "job", { jobId: "11111111-1111-1111-1111-111111111111" });
  });

  it("does not send when the claim conflicts (already followed up)", async () => {
    h.state.claimGranted = false;
    queue([jobRow()]);
    const r = await runFollowUps({ now: NOW });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
  });

  it("skips not-yet-due candidates without claiming or sending", async () => {
    queue([jobRow({ lastCustomerAt: ago(59 * MIN) })]);
    const r = await runFollowUps({ now: NOW });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it("never emails mock jobs or fixture customers by default, but does with FOLLOWUPS_INCLUDE_MOCK=1", async () => {
    queue([jobRow({ isMock: true }), jobRow({ id: "33333333-3333-3333-3333-333333333333", isInternalFixture: true })]);
    await runFollowUps({ now: NOW });
    expect(sendEmail).not.toHaveBeenCalled();
    process.env.FOLLOWUPS_INCLUDE_MOCK = "1";
    queue([jobRow({ isMock: true })]);
    await runFollowUps({ now: NOW });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("gates the monitoring pitch on environment", async () => {
    const delivered = { state: "delivered", deliveredAt: ago(30 * HOUR), lastCustomerAt: null };
    queue([], [], [jobRow({ ...delivered, environment: "test" })]);
    await runFollowUps({ now: NOW });
    expect(sendEmail).not.toHaveBeenCalled();
    queue([], [], [jobRow({ ...delivered })]);
    await runFollowUps({ now: NOW });
    expect(sendEmail.mock.calls[0]![0].subject).toMatch(/monitoring/i);
  });

  it("respects the suppression list", async () => {
    h.state.suppressed = true;
    queue([jobRow()], [], [], [expertRow()]);
    const r = await runFollowUps({ now: NOW });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(r.skipped).toBe(2);
  });

  it("skips (without claiming) when email is not configured", async () => {
    h.state.emailConfigured = false;
    queue([jobRow()]);
    const r = await runFollowUps({ now: NOW });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
    expect(h.state.deletes).toBe(0);
  });

  it("releases the claim and records the error when sending fails", async () => {
    sendEmail.mockRejectedValue(new Error("smtp down"));
    queue([jobRow()]);
    const r = await runFollowUps({ now: NOW });
    expect(r.sent).toBe(0);
    expect(r.errors[0]).toContain("smtp down");
    expect(r.errors[0]).toMatch(/^job:1111/);
    expect(h.state.deletes).toBe(1);
    expect(addMessage).not.toHaveBeenCalled();
  });

  it("keeps the claim if post-send bookkeeping fails (the email went out)", async () => {
    addMessage.mockRejectedValueOnce(new Error("db blip"));
    queue([jobRow()]);
    const r = await runFollowUps({ now: NOW });
    expect(r.sent).toBe(1);
    expect(r.errors[0]).toContain("db blip");
    expect(h.state.deletes).toBe(0);
  });

  it("sends the expert reminder with a fresh opt-out link and records the engagement thread", async () => {
    queue([], [], [], [expertRow()]);
    const r = await runFollowUps({ now: NOW });
    expect(r.sent).toBe(1);
    const mail = sendEmail.mock.calls[0]![0];
    expect(mail.to).toBe("Dana@Example.com");
    expect(mail.text).toContain("https://app.example.com/expert/opt-out/");
    expect(mail.text).toContain("opt out");
    expect(recordEmailThread).toHaveBeenCalledWith("th1", "expert_outreach", { expertEngagementId: "22222222-2222-2222-2222-222222222222" });
  });

  it("restores the token and releases the claim when the expert send fails", async () => {
    sendEmail.mockRejectedValue(new Error("boom"));
    queue([], [], [], [expertRow()]);
    const r = await runFollowUps({ now: NOW });
    expect(r.errors[0]).toMatch(/^expert_engagement:2222.*boom/);
    expect(h.state.updates).toHaveLength(2); // rotate + restore
    expect(h.state.deletes).toBe(1);
  });

  it("abandons the expert reminder if the engagement changed before rotation", async () => {
    h.state.rotated = [];
    queue([], [], [], [expertRow()]);
    const r = await runFollowUps({ now: NOW });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
    expect(h.state.deletes).toBe(1);
  });
});
