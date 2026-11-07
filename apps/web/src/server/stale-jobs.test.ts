import { describe, expect, it, vi } from "vitest";
import {
  classify, decideRecovery, escalationNote, MAX_RECOVERY_ATTEMPTS, PAID_NOT_RESUMED_MS, processStaleJobs, selectStale, WORKING_STALE_MS,
  type StaleCandidate, type StaleJobDeps,
} from "./stale-jobs";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms);
const MIN = 60_000;
const cand = (o: Partial<StaleCandidate> = {}): StaleCandidate => ({
  jobId: "j1", state: "running", updatedAt: ago(30 * MIN), lastProgressAt: ago(30 * MIN), recoveryAt: [], escalatedAt: null,
  unresumedPayment: null, hasResumedPayment: false, ...o,
});

describe("classify", () => {
  it("flags working states only past the threshold", () => {
    expect(classify(cand({ lastProgressAt: ago(WORKING_STALE_MS - MIN), updatedAt: ago(WORKING_STALE_MS - MIN) }), NOW)).toBeNull();
    expect(classify(cand(), NOW)).toBe("working");
    expect(classify(cand({ state: "investigating" }), NOW)).toBe("working");
  });
  it("uses the newer of updatedAt and last progress", () => {
    expect(classify(cand({ updatedAt: ago(MIN) }), NOW)).toBeNull();
  });
  it("ignores terminal and non-working states", () => {
    expect(classify(cand({ state: "delivered" }), NOW)).toBeNull();
    expect(classify(cand({ state: "quoted" }), NOW)).toBeNull();
  });
  it("detects paid-not-resumed after 5 minutes", () => {
    const pay = (age: number) => cand({ state: "awaiting_payment", updatedAt: ago(age), lastProgressAt: ago(age), unresumedPayment: { id: "p", createdAt: ago(age) } });
    expect(classify(pay(PAID_NOT_RESUMED_MS - MIN), NOW)).toBeNull();
    expect(classify(pay(PAID_NOT_RESUMED_MS + MIN), NOW)).toBe("paid_not_resumed");
  });
  it("treats awaiting_payment without a payment as not stale, and resumed-but-stuck as working", () => {
    expect(classify(cand({ state: "awaiting_payment" }), NOW)).toBeNull();
    expect(classify(cand({ state: "awaiting_payment", hasResumedPayment: true }), NOW)).toBe("working");
  });
});

describe("selectStale", () => {
  it("skips jobs already escalated since last progress, but not after new progress", () => {
    expect(selectStale([cand({ escalatedAt: ago(5 * MIN) })], NOW)).toHaveLength(0);
    expect(selectStale([cand({ escalatedAt: ago(40 * MIN) })], NOW)).toHaveLength(1);
  });
  it("applies backoff after a recent attempt", () => {
    expect(selectStale([cand({ recoveryAt: [ago(5 * MIN)] })], NOW)).toHaveLength(0);
    expect(selectStale([cand({ recoveryAt: [ago(20 * MIN)] })], NOW)).toHaveLength(1);
  });
  it("is bounded and oldest first", () => {
    const many = Array.from({ length: 10 }, (_, i) => cand({ jobId: `j${i}`, updatedAt: ago((20 + i) * MIN), lastProgressAt: null }));
    const out = selectStale(many, NOW, 3);
    expect(out.map((x) => x.candidate.jobId)).toEqual(["j9", "j8", "j7"]);
  });
});

describe("decideRecovery", () => {
  it("re-enqueues live runs until the cap, then escalates", () => {
    expect(decideRecovery("working", "alive", 0)).toBe("reenqueue");
    expect(decideRecovery("working", "alive", MAX_RECOVERY_ATTEMPTS - 1)).toBe("reenqueue");
    expect(decideRecovery("working", "alive", MAX_RECOVERY_ATTEMPTS)).toBe("escalate");
  });
  it("escalates dead runs immediately (not restartable) and skips unknown liveness", () => {
    expect(decideRecovery("working", "dead", 0)).toBe("escalate");
    expect(decideRecovery("working", "unknown", 0)).toBe("skip");
  });
  it("replays unresumed payments up to the cap", () => {
    expect(decideRecovery("paid_not_resumed", "alive", 0)).toBe("resume_payment");
    expect(decideRecovery("paid_not_resumed", "alive", MAX_RECOVERY_ATTEMPTS)).toBe("escalate");
  });
  it("explains escalations", () => {
    expect(escalationNote("working", "dead", 0, 30)).toMatch(/no longer active/);
    expect(escalationNote("working", "alive", 3, 30)).toMatch(/3 automatic/);
  });
});

describe("processStaleJobs", () => {
  const deps = (liveness: "alive" | "dead" | "unknown" = "alive"): StaleJobDeps => ({
    liveness: vi.fn(async () => liveness), reenqueue: vi.fn(async () => {}), resumePayment: vi.fn(async () => {}),
    recordAttempt: vi.fn(async () => {}), escalate: vi.fn(async () => {}),
  });
  it("records an attempt then re-enqueues a live stale run", async () => {
    const d = deps();
    const s = await processStaleJobs([cand()], NOW, d);
    expect(s.reenqueued).toEqual(["j1"]);
    expect(d.recordAttempt).toHaveBeenCalledOnce();
    expect(d.escalate).not.toHaveBeenCalled();
  });
  it("escalates a dead run without restarting it", async () => {
    const d = deps("dead");
    const s = await processStaleJobs([cand()], NOW, d);
    expect(s.escalated).toEqual(["j1"]);
    expect(d.reenqueue).not.toHaveBeenCalled();
  });
  it("replays a paid-not-resumed payment", async () => {
    const d = deps();
    const c = cand({ state: "awaiting_payment", unresumedPayment: { id: "pay1", createdAt: ago(30 * MIN) } });
    const s = await processStaleJobs([c], NOW, d);
    expect(s.paymentsResumed).toEqual(["j1"]);
    expect(d.resumePayment).toHaveBeenCalledWith("pay1");
    expect(d.liveness).not.toHaveBeenCalled();
  });
  it("isolates per-job failures", async () => {
    const d = deps();
    (d.reenqueue as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const s = await processStaleJobs([cand({ jobId: "a", updatedAt: ago(60 * MIN), lastProgressAt: null }), cand({ jobId: "b" })], NOW, d);
    expect(s.errors).toEqual(["a: boom"]);
    expect(s.reenqueued).toEqual(["b"]);
  });
});
