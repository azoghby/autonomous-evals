import { describe, expect, it } from "vitest";
import { classifyActivity, cronIntervalMs, describeCron, formatAge, isStaleRunning, summarizeStatus, type Probe } from "./status-logic";

const probe = (over: Partial<Probe>): Probe => ({ id: "x", label: "X", critical: false, level: "ok", latencyMs: 1, notes: [], errorClass: null, ...over });
const NOW = new Date("2026-01-01T12:00:00Z");

describe("summarizeStatus", () => {
  it("is operational when every probe is ok", () => {
    expect(summarizeStatus([probe({}), probe({ id: "y" })])).toMatchObject({ level: "operational", reasons: [] });
  });
  it("is operational for an empty probe list", () => {
    expect(summarizeStatus([]).level).toBe("operational");
  });
  it("is down when a critical probe is down", () => {
    const s = summarizeStatus([probe({ label: "Database", critical: true, level: "down", errorClass: "TimeoutError" })]);
    expect(s.level).toBe("down");
    expect(s.reasons[0]).toBe("Database failed (TimeoutError)");
  });
  it("is only degraded when a non-critical probe is down", () => {
    expect(summarizeStatus([probe({ level: "down" })]).level).toBe("degraded");
  });
  it("degraded for a critical probe that is merely degraded, with its note as the reason", () => {
    const s = summarizeStatus([probe({ label: "Migrations", critical: true, level: "degraded", notes: ["2 pending"] })]);
    expect(s).toMatchObject({ level: "degraded", reasons: ["Migrations: 2 pending"] });
  });
  it("down wins over degraded regardless of order", () => {
    const a = probe({ level: "degraded" });
    const b = probe({ critical: true, level: "down" });
    expect(summarizeStatus([a, b]).level).toBe("down");
    expect(summarizeStatus([b, a]).level).toBe("down");
  });
});

describe("isStaleRunning", () => {
  it("flags items idle longer than 30 minutes", () => {
    expect(isStaleRunning(new Date(NOW.getTime() - 31 * 60_000), NOW)).toBe(true);
    expect(isStaleRunning(new Date(NOW.getTime() - 29 * 60_000), NOW)).toBe(false);
  });
  it("accepts ISO strings and custom thresholds", () => {
    expect(isStaleRunning("2026-01-01T11:50:00Z", NOW, 5 * 60_000)).toBe(true);
  });
});

describe("formatAge", () => {
  it.each([
    [0, "just now"], [30, "30s ago"], [300, "5m ago"], [3 * 3600, "3h ago"], [3 * 86400, "3d ago"],
  ])("%is => %s", (secs, out) => {
    expect(formatAge(new Date(NOW.getTime() - secs * 1000), NOW)).toBe(out);
  });
  it("handles missing, invalid and future values", () => {
    expect(formatAge(null, NOW)).toBe("never");
    expect(formatAge("nope", NOW)).toBe("unknown");
    expect(formatAge(new Date(NOW.getTime() + 60_000), NOW)).toBe("in the future");
  });
});

describe("cron helpers", () => {
  it("derives intervals", () => {
    expect(cronIntervalMs("*/15 * * * *")).toBe(15 * 60_000);
    expect(cronIntervalMs("0 * * * *")).toBe(3_600_000);
    expect(cronIntervalMs("30 5 * * *")).toBe(86_400_000);
    expect(cronIntervalMs("0 9 * * 1")).toBeNull();
    expect(cronIntervalMs("bogus")).toBeNull();
  });
  it("describes cadence", () => {
    expect(describeCron("*/5 * * * *")).toBe("every 5m");
    expect(describeCron("0 * * * *")).toBe("hourly");
    expect(describeCron("30 5 * * *")).toBe("daily 05:30 UTC");
    expect(describeCron("0 9 * * 1")).toBe("0 9 * * 1");
  });
  it("classifies activity against cadence", () => {
    const iv = 15 * 60_000;
    expect(classifyActivity(null, iv, NOW)).toBe("none");
    expect(classifyActivity(new Date(NOW.getTime() - 20 * 60_000), iv, NOW)).toBe("recent");
    expect(classifyActivity(new Date(NOW.getTime() - 3 * 3600_000), iv, NOW)).toBe("quiet");
    expect(classifyActivity(new Date(NOW.getTime() - 99 * 3600_000), null, NOW)).toBe("recent");
  });
});
