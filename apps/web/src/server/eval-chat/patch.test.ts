import { describe, expect, it } from "vitest";
import { lineDiff, promptPatch, withContext } from "./patch";

describe("lineDiff", () => {
  it("marks added and removed lines and keeps unchanged ones as context", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "B" }, { op: " ", text: "c" }, { op: "+", text: "d" },
    ]);
  });
  it("identical text is all context", () => {
    expect(lineDiff("x\ny", "x\ny").every((l) => l.op === " ")).toBe(true);
  });
  it("diffing against empty text marks the whole new text as added", () => {
    expect(lineDiff("", "hello")).toEqual([{ op: "-", text: "" }, { op: "+", text: "hello" }]);
  });
});

describe("withContext", () => {
  it("collapses long unchanged stretches to two lines of context around each change", () => {
    const lines = [...Array.from({ length: 10 }, (_, i) => ({ op: " " as const, text: `l${i}` })), { op: "+" as const, text: "new" }, ...Array.from({ length: 10 }, (_, i) => ({ op: " " as const, text: `m${i}` }))];
    const out = withContext(lines);
    expect(out[0]).toEqual({ op: " ", text: "… 8 unchanged lines" });
    expect(out.map((l) => l.text)).toEqual(["… 8 unchanged lines", "l8", "l9", "new", "m0", "m1", "… 8 unchanged lines"]);
  });
  it("uses the singular for one skipped line", () => {
    const lines = [{ op: "+" as const, text: "a" }, ...Array.from({ length: 5 }, (_, i) => ({ op: " " as const, text: `u${i}` })), { op: "+" as const, text: "b" }];
    expect(withContext(lines).some((l) => l.text === "… 1 unchanged line")).toBe(true);
  });
});

describe("promptPatch", () => {
  const input = { title: "Verify identity", rationale: "Because policy", addition: "Always verify identity first." };
  it("appends the addition when no replace text is given", () => {
    const p = promptPatch("You are an agent.", input, true);
    expect(p.after).toBe("You are an agent.\n\nAlways verify identity first.");
    expect(p.lines.filter((l) => l.op === "+").map((l) => l.text)).toContain("Always verify identity first.");
    expect(p.applyable).toBe(true);
  });
  it("substitutes the replace text when present in the current prompt", () => {
    const p = promptPatch("Be fast.\nRefund anything.", { ...input, addition: "Refund only within 30 days.", replace: "Refund anything." }, true);
    expect(p.after).toBe("Be fast.\nRefund only within 30 days.");
    expect(p.lines).toContainEqual({ op: "-", text: "Refund anything." });
  });
  it("falls back to appending when the replace text is not in the prompt", () => {
    const p = promptPatch("Be fast.", { ...input, replace: "not there" }, true);
    expect(p.after).toBe("Be fast.\n\nAlways verify identity first.");
  });
  it("is not applyable when there is no current prompt, and the addition becomes the whole prompt", () => {
    const p = promptPatch(undefined, input, true);
    expect(p.applyable).toBe(false);
    expect(p.after).toBe("Always verify identity first.");
  });
  it("is not applyable when the target is not hosted, even with a prompt", () => {
    expect(promptPatch("x", input, false).applyable).toBe(false);
  });
  it("clips title, rationale and addition", () => {
    const p = promptPatch("x", { title: "t".repeat(500), rationale: "r".repeat(2_000), addition: "a".repeat(9_000) }, true);
    expect(p.title).toHaveLength(120);
    expect(p.rationale).toHaveLength(600);
    expect(p.after.length).toBeLessThanOrEqual(1 + 2 + 4_000);
  });
});
