import { describe, it, expect } from "vitest";
import { hashToken } from "@ae/core/auth/tokens";
import { generateShareToken, isPlausibleShareToken, redactReport, badgeColor, badgeMessage, renderBadgeSvg, shareUrls, BADGE_COLORS } from "./share-core";

describe("share token", () => {
  it("returns the plaintext once and only a sha256 hash for storage", () => {
    const a = generateShareToken(), b = generateShareToken();
    expect(a.tokenHash).toBe(hashToken(a.token));
    expect(a.tokenHash).not.toContain(a.token);
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(isPlausibleShareToken(a.token)).toBe(true);
    expect(isPlausibleShareToken("short")).toBe(false);
    expect(isPlausibleShareToken("../../etc/passwd")).toBe(false);
  });
});

const finding = (id: string, severity: string, extra: Record<string, unknown> = {}) => ({
  id,
  data: {
    id: `f-${id}`, title: `Bug ${id} at https://api.acme-secret.com/v1/pay`, status: "confirmed", severity, category: "false_success",
    description: "SECRET_DESCRIPTION", scenarioId: "s1", reproductions: 2,
    evidence: [{ kind: "response", excerpt: "EVIDENCE_EXCERPT_LEAK", location: "https://acme-secret.com/trace" }], ...extra,
  },
});
const remediation = (findingRowId: string, status: string) => ({
  findingRowId,
  data: {
    findingId: `f-${findingRowId}`, kind: "prompt_patch", summary: "Add a guard; contact bob@acme.com", patch: "SECRET_PATCH_PROMPT You are a bot",
    rationale: "SECRET_RATIONALE",
    verification: { status, before: { passed: 1, total: 4 }, after: { passed: 4, total: 4 }, regressions: 0, evidence: [{ kind: "judge", excerpt: "EVIDENCE_EXCERPT_LEAK" }] },
  },
});
const job = { package: "trace_audit", deliveredAt: new Date("2026-11-08T10:00:00Z"), isMock: false, environment: "live" };

describe("redactReport", () => {
  const report = redactReport(job,
    [finding("1", "critical"), finding("2", "high"), finding("3", "low"), { id: "4", data: { ...finding("4", "high").data, status: "inconclusive" } }],
    [remediation("1", "verified"), remediation("2", "not_verified")]);
  const json = JSON.stringify(report);

  it("never leaks evidence, urls, prompts/patches, descriptions or identity", () => {
    for (const bad of ["EVIDENCE_EXCERPT_LEAK", "acme-secret", "SECRET_PATCH_PROMPT", "SECRET_RATIONALE", "SECRET_DESCRIPTION", "bob@acme.com", "http", "evidence", '"patch":', "endpoint", "customer", '"email']) {
      expect(json).not.toContain(bad);
    }
  });
  it("keeps titles, categories, severities, fix summaries and before/after", () => {
    expect(report.findings.map((f) => f.severity)).toEqual(["critical", "high", "low"]);
    expect(report.findings[0].fix).toMatchObject({ verification: "verified", before: { passed: 1, total: 4 }, after: { passed: 4, total: 4 } });
    expect(report.findings[0].category).toBe("false_success");
    expect(report.counts).toEqual({ critical: 1, high: 1, medium: 0, low: 1 });
    expect(report.fixedCount).toBe(1);
    expect(report.openCounts).toEqual({ critical: 0, high: 1, medium: 0, low: 1 });
    expect(report.deliveredAt).toBe("2026-11-08T10:00:00.000Z");
  });
  it("flags mock and test-environment jobs as sample data", () => {
    expect(report.isSample).toBe(false);
    expect(redactReport({ ...job, isMock: true }, [], []).isSample).toBe(true);
    expect(redactReport({ ...job, environment: "test" }, [], []).isSample).toBe(true);
  });
});

describe("badge", () => {
  const z = { critical: 0, high: 0, medium: 0, low: 0 };
  it("is blue with no open high/critical, orange for high, red for critical", () => {
    expect(badgeColor(z)).toBe(BADGE_COLORS.blue);
    expect(badgeColor({ ...z, medium: 3, low: 2 })).toBe(BADGE_COLORS.blue);
    expect(badgeColor({ ...z, high: 1 })).toBe(BADGE_COLORS.orange);
    expect(badgeColor({ ...z, high: 1, critical: 1 })).toBe(BADGE_COLORS.red);
  });
  it("formats the message and renders escaped svg", () => {
    expect(badgeMessage({ openCounts: z, fixedCount: 2 })).toBe("0 critical · 2 fixed");
    const svg = renderBadgeSvg("Standard Evals", "<x> & 2 fixed", BADGE_COLORS.blue);
    expect(svg).toContain("<svg");
    expect(svg).toContain("&lt;x&gt; &amp;");
    expect(svg).toContain(BADGE_COLORS.blue);
  });
  it("builds a markdown snippet linking the badge to the share page", () => {
    const u = shareUrls("https://x.test/", "tok");
    expect(u.url).toBe("https://x.test/r/tok");
    expect(u.markdown).toBe("[![Standard Evals](https://x.test/r/tok/badge.svg)](https://x.test/r/tok)");
  });
});
