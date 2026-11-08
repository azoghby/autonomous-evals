import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Suite } from "../../../../packages/core/src/contracts/index";
import { buildStandardSuite, suiteCounts } from "./leaderboard-suite";

const frozen = JSON.parse(readFileSync(new URL("../../../../data/standard-suite-v1.json", import.meta.url), "utf8"));

describe("standard suite v1", () => {
  it("frozen JSON validates against the Suite contract", () => { expect(Suite.safeParse(frozen).success).toBe(true); });
  it("frozen JSON equals the deterministic builder output (no drift)", () => { expect(frozen).toEqual(JSON.parse(JSON.stringify(buildStandardSuite()))); });
  it("has 12 designed + 20 red-team scenarios with unique ids and no tool-requiring red-team scenarios", () => {
    const s = Suite.parse(frozen);
    expect(suiteCounts(s)).toEqual({ total: 32, designed: 12, redTeam: 20 });
    expect(new Set(s.scenarios.map((x) => x.id)).size).toBe(32);
    for (const sc of s.scenarios.filter((x) => x.id.startsWith("rt_"))) {
      const rt = (sc.checks[0]!.spec as { redteam: { requires: { tools: boolean } } }).redteam;
      expect(rt.requires.tools).toBe(false);
    }
  });
  it("designed scenarios each have at least one check and use only known objective spec types", () => {
    const known = new Set(["contains", "not_contains", "contains_any", "max_chars", "min_chars", "max_words", "max_lines", "json_valid", "json_has_keys"]);
    for (const sc of Suite.parse(frozen).scenarios.filter((x) => !x.id.startsWith("rt_"))) {
      expect(sc.checks.length).toBeGreaterThan(0);
      for (const c of sc.checks.filter((k) => k.kind === "objective")) expect(known.has(String(c.spec.type))).toBe(true);
    }
  });
});
