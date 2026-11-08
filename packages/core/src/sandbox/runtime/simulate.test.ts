import { describe, expect, it } from "vitest";
import type { generateStructured } from "../../ai/gateway";
import type { ToolSpec } from "../spec";
import { createGatewaySimulator, snapshotSql } from "./simulate";

const tool: ToolSpec = {
  name: "send_email",
  description: "Sends an email",
  inputSchema: {},
  outputSchema: { type: "object", properties: { sent: { type: "boolean" } } },
  effect: "external",
  binding: { kind: "simulated", instructions: "ALWAYS-SUCCEED-MARKER", readsTables: [], recordsOutbox: true },
  source: "json:send_email",
};
const ctx = { recordCost: async () => {} };

function fake(object: unknown) {
  const calls: Array<Parameters<typeof generateStructured>[0]> = [];
  const generate = (async (args: Parameters<typeof generateStructured>[0]) => {
    calls.push(args);
    return { object };
  }) as unknown as typeof generateStructured;
  return { calls, generate };
}

describe("createGatewaySimulator", () => {
  it("builds prompt and passes output through", async () => {
    const { calls, generate } = fake({ result: { sent: true }, sideEffects: [{ to: "a@b.c" }] });
    const sim = createGatewaySimulator({ ctx, generate, frozenNow: "2026-06-01T15:00:00Z", model: undefined });
    const out = await sim(tool, { to: "a@b.c" }, { orders: [{ id: 7 }] });
    expect(out).toEqual({ result: { sent: true }, sideEffects: [{ to: "a@b.c" }] });
    const c = calls[0]!;
    expect(c.system).toContain("ALWAYS-SUCCEED-MARKER");
    expect(c.system).toContain("2026-06-01T15:00:00Z");
    expect(c.system).toContain('"sent":{"type":"boolean"}');
    expect(c.prompt).toContain('{"to":"a@b.c"}');
    expect(c.prompt).toContain('"orders":[{"id":7}]');
    expect(c.temperature).toBe(0);
    expect(c.maxOutputTokens).toBe(2000);
    expect(c.timeoutMs).toBe(30000);
  });
  it("omits sideEffects when absent and truncates huge snapshots", async () => {
    const { calls, generate } = fake({ result: 1 });
    const sim = createGatewaySimulator({ ctx, generate });
    const out = await sim(tool, {}, { t: [{ blob: "x".repeat(30_000) }] });
    expect(out).toEqual({ result: 1 });
    expect(calls[0]!.prompt.length).toBeLessThan(21_000);
    expect(calls[0]!.prompt).toContain("[truncated]");
  });
  it("propagates errors", async () => {
    const generate = (async () => { throw new Error("boom"); }) as unknown as typeof generateStructured;
    await expect(createGatewaySimulator({ ctx, generate })(tool, {}, {})).rejects.toThrow("boom");
  });
});

describe("snapshotSql", () => {
  it("quotes identifiers", () => {
    expect(snapshotSql("orders")).toBe('SELECT * FROM "orders" LIMIT 50');
    expect(snapshotSql("order_items", 5)).toBe('SELECT * FROM "order_items" LIMIT 5');
  });
  it("rejects bad names", () => {
    for (const bad of ['a"b', "Orders", "1x", "a b", "", "x;drop", "a".repeat(64)]) {
      expect(() => snapshotSql(bad)).toThrow();
    }
  });
});
