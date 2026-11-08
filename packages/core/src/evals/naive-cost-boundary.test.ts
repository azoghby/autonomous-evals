import { describe, expect, it, vi } from "vitest";
import { toContractCost, TrackBBlockedError } from "./service-adapter";
import type { CostEntry } from "./types";
const cost = (): CostEntry => ({ jobId: "job-test", source: "naive_session", role: "commercial", externalId: "ses_test-123", purpose: "qualify_r0", microUsd: 125, measured: true, recordedAt: "2026-11-07T00:00:00Z" });
describe("Naive contract cost boundary", () => {
  it.each([
    { measured: false }, { measured: undefined }, { externalId: null }, { externalId: "" },
    { externalId: " ses_test" }, { externalId: "ses_test\nsecret" }, { externalId: "x".repeat(201) },
    { microUsd: -1 }, { microUsd: 0.5 }, { microUsd: NaN }, { microUsd: Infinity },
    { microUsd: Number.MAX_SAFE_INTEGER + 1 }, { microUsd: "125" }, { source: "ai_gateway" }, { role: "unknown" },
  ])("refuses malformed or unmeasured receipts without calling a sink: %j", async change => {
    const sink = vi.fn();
    const deliver = async () => sink(toContractCost({ ...cost(), ...change } as CostEntry));
    await expect(deliver()).rejects.toMatchObject({ code: "needs_operator", message: "Measured Naive cost receipt unavailable", retryable: false, sessionIds: [] });
    expect(sink).not.toHaveBeenCalled();
  });
  it("rejects missing input with a static diagnostic", () => {
    expect(() => toContractCost(null as unknown as CostEntry)).toThrow(TrackBBlockedError);
  });
  it("keeps measured zero and stable session keys across changed delivery timestamps", () => {
    const zero = { ...cost(), microUsd: 0, role: null };
    const first = toContractCost(zero), replay = toContractCost({ ...zero, recordedAt: "2026-12-01T00:00:00Z" });
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ source: "naive", sessionId: "ses_test-123", microUsd: 0, meta: { measured: true, idempotencyKey: "naive:ses_test-123" } });
  });
  it("redelivers unchanged evidence after a sink loses acknowledgement, without inventing local dedupe", async () => {
    const delivered: unknown[] = [];
    const sink = vi.fn(async (entry: unknown) => { delivered.push(entry); if (delivered.length === 1) throw Error("lost acknowledgement"); });
    await expect(sink(toContractCost(cost()))).rejects.toThrow("lost acknowledgement");
    await sink(toContractCost(cost()));
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toEqual(delivered[1]);
    expect(toContractCost({ ...cost(), externalId: "ses_another" }).meta.idempotencyKey).not.toEqual(toContractCost(cost()).meta.idempotencyKey);
  });
});
