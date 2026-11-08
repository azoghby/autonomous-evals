import { describe, expect, it } from "vitest";
import { FaultScheduler, applyPostFault, argsKey, preExecutionFault } from "./faults";

describe("FaultScheduler", () => {
  it("counts per tool and fires only on matching call", () => {
    const s = new FaultScheduler([{ tool: "a", onCall: 2, fault: "http_500" }]);
    expect(s.next("a")).toEqual({ call: 1 });
    expect(s.next("b")).toEqual({ call: 1 });
    expect(s.next("a")).toEqual({ call: 2, fault: { kind: "http_500", payload: undefined } });
    expect(s.next("a")).toEqual({ call: 3 });
  });
  it("handles multiple faults, first match wins, defaults onCall to 1", () => {
    const s = new FaultScheduler([
      { tool: "a", fault: "timeout" } as never,
      { tool: "a", onCall: 1, fault: "http_500" },
      { tool: "a", onCall: 2, fault: "injected_instruction", payload: "p" },
    ]);
    expect(s.next("a").fault?.kind).toBe("timeout");
    expect(s.next("a").fault).toEqual({ kind: "injected_instruction", payload: "p" });
  });
  it("copies inputs", () => {
    const input = [{ tool: "a", onCall: 1, fault: "http_500" as const }];
    const s = new FaultScheduler(input);
    input[0]!.tool = "z";
    expect(s.next("a").fault?.kind).toBe("http_500");
  });
});

describe("preExecutionFault", () => {
  it("returns messages for pre-exec kinds", () => {
    expect(preExecutionFault("http_500")).toEqual({ error: "HTTP 500: Internal Server Error (upstream failure)" });
    expect(preExecutionFault("timeout")).toEqual({ error: "timeout: upstream did not respond within 30s" });
    expect(preExecutionFault("rate_limited")).toEqual({ error: "HTTP 429: rate limited, retry after 2s" });
  });
  it("returns null otherwise", () => {
    expect(preExecutionFault("empty_result")).toBeNull();
    expect(preExecutionFault("stale_data")).toBeNull();
    expect(preExecutionFault("injected_instruction")).toBeNull();
  });
});

describe("applyPostFault", () => {
  const h = { hasPrior: false };
  it("empty_result by shape", () => {
    expect(applyPostFault("empty_result", [{ a: 1 }], { ...h, shape: "rows" })).toEqual([]);
    expect(applyPostFault("empty_result", { a: 1 }, { ...h, shape: "row" })).toBeNull();
    expect(applyPostFault("empty_result", 3, { ...h, shape: "count" })).toBe(0);
    expect(applyPostFault("empty_result", 1, { ...h, shape: "none" })).toEqual({ ok: true });
    expect(applyPostFault("empty_result", 1, h)).toBeNull();
  });
  it("stale_data", () => {
    expect(applyPostFault("stale_data", "new", { hasPrior: true, priorResult: "old" })).toBe("old");
    expect(applyPostFault("stale_data", "new", { hasPrior: false })).toBe("new");
  });
  it("injected_instruction plants payload without mutating", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const out = applyPostFault("injected_instruction", rows, { ...h, payload: "P" }) as Array<Record<string, unknown>>;
    expect(out).toEqual([{ id: 1 }, { id: 2, notes: "P" }]);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    const obj = { a: 1 };
    expect(applyPostFault("injected_instruction", obj, { ...h, payload: "P" })).toEqual({ a: 1, notes: "P" });
    expect(obj).toEqual({ a: 1 });
    expect(applyPostFault("injected_instruction", "hi", { ...h, payload: "P" })).toBe("hi\n\nP");
    expect(applyPostFault("injected_instruction", [], { ...h, payload: "P" })).toEqual([{ notes: "P" }]);
    expect(applyPostFault("injected_instruction", null, { ...h, payload: "P" })).toEqual({ value: null, notes: "P" });
    expect(applyPostFault("injected_instruction", 5, { ...h, payload: "P" })).toEqual({ value: 5, notes: "P" });
  });
  it("uses default payload with canary", () => {
    const out = applyPostFault("injected_instruction", "x", h) as string;
    expect(out).toContain("canary:AE-CANARY-7731");
  });
});

describe("argsKey", () => {
  it("is stable across key order", () => {
    expect(argsKey("t", { b: 1, a: { d: 1, c: [{ y: 1, x: 2 }] } })).toBe(argsKey("t", { a: { c: [{ x: 2, y: 1 }], d: 1 }, b: 1 }));
    expect(argsKey("t", { a: 1 })).not.toBe(argsKey("u", { a: 1 }));
  });
});
