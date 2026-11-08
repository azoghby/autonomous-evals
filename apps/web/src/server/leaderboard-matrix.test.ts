import { describe, expect, it } from "vitest";
import { agentKey, agentName, buildAgentMatrix, modelLabel, sortMatrixRows } from "./leaderboard-matrix";

const e = (slug: string, model: string, passRate: number, rank = 1, extra: Record<string, unknown> = {}) => ({
  slug, name: `${slug.split("--")[0]} agent · ${modelLabel(model)}`, vendor: "V", kind: "local_reference", model,
  passRate, redTeamRate: 0.9, criticalCount: 0, rank, ...extra,
});

describe("buildAgentMatrix", () => {
  it("groups agent x model rows by slug prefix with one cell per model", () => {
    const m = buildAgentMatrix([
      e("a--gpt-5-5", "openai/gpt-5.5", 0.9, 1, { homepage: "https://src/a", termsUrl: "https://lic/a" }),
      e("a--claude-sonnet-5-5", "anthropic/claude-sonnet-5.5", 0.7, 3),
      e("b--gpt-5-5", "openai/gpt-5.5", 0.8, 2),
    ]);
    expect(m.rows.map((r) => r.key)).toEqual(["a", "b"]); // both mean 0.8: tie breaks on name
    const a = m.rows.find((r) => r.key === "a")!;
    expect(a.name).toBe("a agent");
    expect(a.homepage).toBe("https://src/a");
    expect(a.termsUrl).toBe("https://lic/a");
    expect(a.runs).toBe(2);
    expect(a.best).toBeCloseTo(0.9);
    expect(a.mean).toBeCloseTo(0.8);
    expect(m.columns.map((c) => c.label)).toEqual(["GPT-5.5", "Claude Sonnet 5.5"]); // most-used model first
  });

  it("skips entries without a model and keeps the first entry per agent+model", () => {
    const m = buildAgentMatrix([e("a--x", "openai/gpt-5.5", 0.5), e("a--y", "openai/gpt-5.5", 0.1), { ...e("c", "", 1), model: null }]);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]!.cells["openai/gpt-5.5"]!.passRate).toBe(0.5);
  });
});

describe("sortMatrixRows", () => {
  const m = buildAgentMatrix([
    e("a--g", "openai/gpt-5.5", 0.6), e("a--o", "anthropic/claude-opus-5.5", 1),
    e("b--g", "openai/gpt-5.5", 0.9),
    e("c--o", "anthropic/claude-opus-5.5", 0.5),
  ]);
  it("sorts by a model column, missing cells last in both directions", () => {
    expect(sortMatrixRows(m.rows, "model:openai/gpt-5.5", "desc").map((r) => r.key)).toEqual(["b", "a", "c"]);
    expect(sortMatrixRows(m.rows, "model:openai/gpt-5.5", "asc").map((r) => r.key)).toEqual(["a", "b", "c"]);
  });
  it("sorts by name, mean and best without mutating the input", () => {
    const before = m.rows.map((r) => r.key);
    expect(sortMatrixRows(m.rows, "name", "asc").map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(sortMatrixRows(m.rows, "best", "desc").map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(sortMatrixRows(m.rows, "mean", "asc").map((r) => r.key)).toEqual(["c", "a", "b"]);
    expect(m.rows.map((r) => r.key)).toEqual(before);
  });
});

describe("labels", () => {
  it("derives keys, names and model labels", () => {
    expect(agentKey("pydantic-ai-bank-support--gpt-5-5")).toBe("pydantic-ai-bank-support");
    expect(agentName("Pydantic AI bank_support example · GPT-5.5")).toBe("Pydantic AI bank_support example");
    expect(modelLabel("google/gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(modelLabel("meta/llama-9")).toBe("llama-9");
  });
});
