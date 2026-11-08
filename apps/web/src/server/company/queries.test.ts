import { describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({ getAgentToggles: async () => new Map(), companySpentTodayMicroUsd: async () => 0 }));

import { sanitizeCounts, sanitizePublicText, staticOrgChart, summarizeActivity, toPublicActivity } from "./queries";

const row = (over: Record<string, unknown> = {}) => ({
  agentId: "prospecting", status: "ok", startedAt: new Date("2026-11-06T11:30:00Z"),
  publicSummary: "Added 4 new leads.", counts: { leads: 4 },
  summary: "Found Acme Corp (jane@acme.ai) at https://acme.ai", detail: { company: "Acme Corp", email: "jane@acme.ai" }, ...over,
});

describe("toPublicActivity", () => {
  it("never leaks summary, detail, names or emails", () => {
    const p = toPublicActivity(row());
    expect(JSON.stringify(p)).not.toMatch(/Acme|jane@|acme\.ai/);
    expect(Object.keys(p).sort()).toEqual(["agentId", "at", "counts", "publicSummary", "status"]);
  });

  it("strips emails and URLs from publicSummary", () => {
    const p = toPublicActivity(row({ publicSummary: "Drafted for bob@corp.com, see https://corp.com/x and www.foo.io/bar today" }));
    expect(p.publicSummary).not.toMatch(/@|https?:|corp\.com|foo\.io/);
    expect(p.publicSummary).toContain("Drafted for");
  });

  it("returns null when nothing is left", () => {
    expect(sanitizePublicText("jane@acme.ai")).toBeNull();
    expect(sanitizePublicText(null)).toBeNull();
  });

  it("drops non-numeric and oddly-named counts", () => {
    expect(sanitizeCounts({ leads: 3, "jane@x.com": 1, note: "Acme", bad: Number.NaN })).toEqual({ leads: 3 });
  });
});

describe("summarizeActivity", () => {
  it("sums counts, tallies status and picks the latest", () => {
    const m = summarizeActivity([
      row({ startedAt: new Date("2026-11-05T11:00:00Z"), counts: { leads: 2 }, publicSummary: "older" }),
      row({ startedAt: new Date("2026-11-06T11:00:00Z"), counts: { leads: 5 }, publicSummary: "newer" }),
      row({ status: "failed", startedAt: new Date("2026-11-04T11:00:00Z"), counts: {} }),
    ]);
    const s = m.get("prospecting")!;
    expect(s).toMatchObject({ runs: 3, ok: 2, failed: 1, counts: { leads: 7 } });
    expect(s.latest?.publicSummary).toBe("newer");
  });
});

describe("staticOrgChart", () => {
  it("lists every org node with activity unavailable", () => {
    const c = staticOrgChart(new Date("2026-11-07T00:00:00Z"));
    expect(c.activityAvailable).toBe(false);
    expect(c.agents.length).toBe(13);
    expect(c.agents.every((a) => a.activity === null)).toBe(true);
  });
});
