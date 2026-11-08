import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadClauseIds, parsePolicies } from "./policies";

const acme = readFileSync(new URL("../../../../../data/envs/acme-support/policies.md", import.meta.url), "utf8");

describe("parsePolicies", () => {
  it("parses the acme-support policy", () => {
    const doc = parsePolicies(acme);
    expect(doc.title).toBe("Acme Support Policy");
    expect(doc.id).toBe("acme_support_policy");
    expect(loadClauseIds(doc)).toEqual([
      "P1.1", "P1.2", "P1.3", "P2.1", "P2.2", "P2.3", "P2.4", "P3.1", "P3.2",
      "P4.1", "P4.2", "P5.1", "P5.2", "P6.1", "P6.2", "P6.3",
    ]);
    expect(doc.clauses[0].text.startsWith("Before any account action")).toBe(true);
    expect(doc.clauses.every((c) => !/^\d/.test(c.text))).toBe(true);
  });

  it("appends continuation lines to the previous clause", () => {
    const doc = parsePolicies("# T\n## 1. A\n1.1 First line\n  indented more\nplain follow\n1.2 Second\n");
    expect(doc.clauses).toEqual([
      { id: "P1.1", text: "First line indented more plain follow" },
      { id: "P1.2", text: "Second" },
    ]);
  });

  it("handles numbered lists under numbered sections", () => {
    const doc = parsePolicies("# Rules\n## 3. Things\n1. one\n2) two\n");
    expect(loadClauseIds(doc)).toEqual(["P3.1", "P3.2"]);
    expect(doc.id).toBe("rules");
  });

  it("numbers bullets by heading number or heading index", () => {
    const doc = parsePolicies("# X\n## Plain\n- a\n- b\n## 5. Numbered\n- c\n");
    expect(loadClauseIds(doc)).toEqual(["P1.1", "P1.2", "P5.1"]);
  });

  it("uses P1, P2 for documents with no numbering", () => {
    const doc = parsePolicies("First paragraph\nstill first.\n\nSecond paragraph.\n\n- bullet\n");
    expect(loadClauseIds(doc)).toEqual(["P1", "P2", "P3"]);
    expect(doc.title).toBe("Policy");
    expect(doc.clauses[0].text).toBe("First paragraph still first.");
  });

  it("applies option overrides and does not treat bare headings as clauses", () => {
    const doc = parsePolicies("# Ignored\n## 1. Heading only\n1.1 Real\n", { id: "my_doc", title: "Custom" });
    expect(doc.id).toBe("my_doc");
    expect(doc.title).toBe("Custom");
    expect(loadClauseIds(doc)).toEqual(["P1.1"]);
  });

  it("disambiguates duplicate ids deterministically and truncates text", () => {
    const long = "x".repeat(2500);
    const doc = parsePolicies(`## 1. A\n1.1 one\n1.1 two\n1.1 ${long}\n`);
    expect(loadClauseIds(doc)).toEqual(["P1.1", "P1.1-b", "P1.1-c"]);
    expect(doc.clauses[2].text).toHaveLength(2000);
  });

  it("derives a valid id from awkward titles", () => {
    expect(parsePolicies("# 2024 Rules!\n- a\n").id).toBe("p_2024_rules");
  });

  it("throws when no clauses are found", () => {
    expect(() => parsePolicies("# Title only\n## 1. Heading\n")).toThrow(/no policy clauses/);
    expect(() => parsePolicies("")).toThrow(/no policy clauses/);
  });
});
