import { describe, expect, it } from "vitest";
import {
  changedKeys, ciBand, clampPanelWidth, effectiveStatus, newScenarios, orderTimeline, parseInline, pct, personaLabel,
  progressPct, relativeDate, splitParagraphs, usd,
} from "./format";
import type { DraftScenario } from "../sandbox/contract";

const ds = (id: string): DraftScenario => ({ scenario: { id } as DraftScenario["scenario"], decision: "pending", edited: false });

describe("formatters", () => {
  it("formats percent and handles missing values", () => {
    expect(pct(0.8333)).toBe("83%");
    expect(pct(null)).toBe("–");
    expect(pct(Number.NaN)).toBe("–");
  });
  it("formats currency with extra precision for tiny amounts", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(0.0042)).toBe("$0.0042");
    expect(usd(1.234)).toBe("$1.23");
  });
  it("describes relative dates", () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    expect(relativeDate("2026-01-10T11:59:50Z", now)).toBe("just now");
    expect(relativeDate("2026-01-10T11:30:00Z", now)).toBe("30m ago");
    expect(relativeDate("2026-01-10T07:00:00Z", now)).toBe("5h ago");
    expect(relativeDate("2026-01-07T12:00:00Z", now)).toBe("3d ago");
    expect(relativeDate("2025-06-01T00:00:00Z", now)).toBe("2025-06-01");
  });
  it("clamps panel width to 360-720", () => {
    expect(clampPanelWidth(100)).toBe(360);
    expect(clampPanelWidth(900)).toBe(720);
    expect(clampPanelWidth(500.4)).toBe(500);
    expect(clampPanelWidth(Number.NaN)).toBe(440);
  });
  it("computes progress and CI band safely", () => {
    expect(progressPct(3, 12)).toBe(25);
    expect(progressPct(1, 0)).toBe(0);
    expect(ciBand([0.9, 0.5])).toEqual({ left: 50, width: 40 });
    expect(ciBand([0.5, 0.5]).width).toBeGreaterThan(0);
    expect(ciBand([-1, 2])).toEqual({ left: 0, width: 100 });
  });
});

describe("draft and diff helpers", () => {
  it("selects only scenarios not in the base run", () => {
    const out = newScenarios([ds("a"), ds("b"), ds("c")], ["a", "c"]);
    expect(out.map((s) => s.scenario.id)).toEqual(["b"]);
    expect(newScenarios([ds("a")], ["a"])).toEqual([]);
  });
  it("reads persona goal, then name, defensively", () => {
    expect(personaLabel({ goal: " Get a refund ", name: "Sam" })).toBe("Get a refund");
    expect(personaLabel({ name: "Sam" })).toBe("Sam");
    expect(personaLabel(null)).toBeNull();
    expect(personaLabel("x")).toBeNull();
    expect(personaLabel({ goal: 3 })).toBeNull();
  });
  it("detects changed keys including added and removed ones", () => {
    expect(changedKeys({ a: 1, b: { x: 1 } }, { a: 1, b: { x: 2 }, c: 3 })).toEqual(["b", "c"]);
    expect(changedKeys({ a: 1 }, null)).toEqual(["a"]);
    expect(changedKeys(null, { a: 1 })).toEqual(["a"]);
    expect(changedKeys({ a: 1 }, { a: 1 })).toEqual([]);
  });
  it("orders timeline steps by seq without mutating input", () => {
    const steps = [{ seq: 2 }, { seq: 0 }, { seq: 1 }].map((s) => ({ ...s, kind: "tool" as const, label: "", detail: "" }));
    expect(orderTimeline(steps).map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(steps[0]?.seq).toBe(2);
  });
});

describe("action status", () => {
  const card = { status: "proposed" as const, expiresAt: "2026-01-01T00:00:00Z" };
  it("prefers the server result", () => {
    expect(effectiveStatus(card, { actionId: "x", status: "executed" }, Date.parse("2027-01-01"))).toBe("executed");
  });
  it("marks unresolved proposals past expiry as expired", () => {
    expect(effectiveStatus(card, undefined, Date.parse("2026-02-01"))).toBe("expired");
    expect(effectiveStatus(card, undefined, Date.parse("2025-12-01"))).toBe("proposed");
  });
});

describe("text parsing", () => {
  it("splits bold and code without producing HTML", () => {
    expect(parseInline("a **b** `c` <b>d</b>")).toEqual([
      { type: "text", value: "a " }, { type: "bold", value: "b" }, { type: "text", value: " " },
      { type: "code", value: "c" }, { type: "text", value: " <b>d</b>" },
    ]);
  });
  it("leaves unmatched markers as text", () => {
    expect(parseInline("2 ** 3 and `open")).toEqual([{ type: "text", value: "2 ** 3 and `open" }]);
  });
  it("splits paragraphs on blank lines", () => {
    expect(splitParagraphs("a\nb\n\n\n c \n\n")).toEqual(["a\nb", "c"]);
  });
});

import { clip, humanize, severityTone, summarizeResults, trialCells } from "./format";

describe("labels and summaries", () => {
  it("humanizes snake case", () => {
    expect(humanize("policy_conflict")).toBe("Policy conflict");
    expect(humanize("")).toBe("");
  });
  it("maps severity to a tone", () => {
    expect(severityTone("Critical")).toBe("danger");
    expect(severityTone("medium")).toBe("warn");
    expect(severityTone("low")).toBe("muted");
  });
  it("summarizes run results", () => {
    expect(summarizeResults([])).toBeNull();
    expect(summarizeResults([{ passRate: 1, reliable: true }, { passRate: 0.5, reliable: false }])).toEqual({ passAt1: 0.75, passHatK: 0.5 });
  });
  it("builds trial cells with a cap", () => {
    expect(trialCells(2, 4)).toEqual([true, true, false, false]);
    expect(trialCells(0, 100)).toHaveLength(24);
    expect(trialCells(1, -3)).toEqual([]);
  });
  it("clips long text", () => {
    expect(clip("abc", 5)).toEqual({ text: "abc", clipped: false });
    expect(clip("abcdefgh", 4)).toEqual({ text: "abcd…", clipped: true });
  });
});
