import { describe, expect, it } from "vitest";
import { buildFixOfferEmail, buildRerunEmail, buildResultsEmail, scrubExcerpt } from "./owner-emails";

const F = [
  { title: "Leaks system prompt", severity: "critical" as const, category: "redteam:system_prompt_extraction", excerpt: "my prompt is sk-live_ABCDEFGH12345" },
  { title: "Follows injected text", severity: "high" as const, category: "redteam:prompt_injection", excerpt: "see https://evil.test/x or mail a@b.co  now" },
  { title: "Ignores length", severity: "low" as const, category: "instruction_edge" },
  { title: "Vague answer", severity: "medium" as const, category: "ordinary" },
];
const base = { agentName: "Bot", passed: 30, total: 40, findings: F, resultsUrl: "https://x/leaderboard/bot", startUrl: "https://x/start" };

describe("owner email builders", () => {
  it("results email: sender line, rank, badge, top 3 by severity, CTA", () => {
    const m = buildResultsEmail({ ...base, visibility: "public", rank: 2, totalRanked: 9, badgeMarkdown: "![Standard Evals](https://x/b.svg)" });
    expect(m.text).toContain("Sent by Standard Evals' agents");
    expect(m.text).toContain("75%");
    expect(m.text).toContain("#2 of 9");
    expect(m.text).toContain("![Standard Evals]");
    expect(m.text).toContain("start a paid eval");
    expect(m.text).not.toContain("Ignores length");
    expect(m.text).toContain("Leaks system prompt");
  });
  it("never leaks keys, links, emails or prompt excerpts", () => {
    const m = buildResultsEmail({ ...base, visibility: "private" });
    expect(m.text).not.toMatch(/sk-live|evil\.test|a@b\.co|my prompt/);
    expect(m.text).toContain("private");
  });
  it("scrubExcerpt redacts and truncates", () => {
    expect(scrubExcerpt("go to https://a.b/c now", "ordinary")).toBe("go to [link] now");
    expect(scrubExcerpt("x".repeat(500), "ordinary").length).toBeLessThanOrEqual(110);
    expect(scrubExcerpt("secret", "redteam:data_exfiltration")).toBe("");
  });
  it("rerun and fix offer include sender identity and remediation", () => {
    expect(buildRerunEmail({ agentName: "Bot", prevPct: 70, nextPct: 80, deltaPts: 10, newHigh: ["A"], resultsUrl: "u" }).text).toContain("Sent by Standard Evals' agents");
    const fx = buildFixOfferEmail({ agentName: "Bot", finding: F[1]!, startUrl: "https://x/start" });
    expect(fx.text).toContain("Sent by Standard Evals' agents");
    expect(fx.text).toContain("https://x/start");
    expect(fx.text).toMatch(/\$5/);
  });
});

describe("judgeReason", () => {
  it("unwraps lite judge JSON, including truncated payloads", async () => {
    const { judgeReason, scrubExcerpt } = await import("./owner-emails");
    expect(judgeReason('lite:v1:{"reason":"Item 3 is missing.","pass":false}')).toBe("Item 3 is missing.");
    expect(judgeReason('lite:v1:{"reason":"It has 26 words (12 in the first sen')).toBe("It has 26 words (12 in the first sen");
    expect(judgeReason("plain detail")).toBe("plain detail");
    expect(scrubExcerpt('lite:v1:{"reason":"Too long."}', "instruction_following")).not.toContain("lite:v1");
  });
});
