import { describe, expect, it } from "vitest";
import { parseMcpTools } from "./mcp";
import { PLACEHOLDER_BINDING } from "./types";

const tool = (o: Record<string, unknown>) => ({ name: "refund_order", description: "d", inputSchema: { type: "object", properties: { id: { type: "string" } } }, ...o });

describe("parseMcpTools", () => {
  it("parses tools/list result", () => {
    const [t] = parseMcpTools({ tools: [tool({ outputSchema: { type: "object" } })] });
    expect(t).toMatchObject({ name: "refund_order", source: "mcp:refund_order", effect: "write", outputSchema: { type: "object" } });
    expect(t.binding).toEqual(PLACEHOLDER_BINDING);
  });
  it("parses bare array and JSON-RPC envelope (string)", () => {
    expect(parseMcpTools([tool({})])).toHaveLength(1);
    expect(parseMcpTools(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [tool({})] } }))).toHaveLength(1);
  });
  it("defaults missing inputSchema", () => {
    expect(parseMcpTools([{ name: "x" }])[0].inputSchema).toEqual({ type: "object", properties: {} });
  });
  it("uses annotations for effect", () => {
    expect(parseMcpTools([tool({ annotations: { readOnlyHint: true } })])[0].effect).toBe("read");
    expect(parseMcpTools([tool({ annotations: { openWorldHint: true } })])[0].effect).toBe("external");
    expect(parseMcpTools([tool({ annotations: { readOnlyHint: true, openWorldHint: true } })])[0].effect).toBe("read");
    expect(parseMcpTools([tool({ annotations: { destructiveHint: true } })])[0].effect).toBe("write");
  });
  it("falls back to name heuristic", () => {
    expect(parseMcpTools([tool({ name: "get_user" })])[0].effect).toBe("read");
    expect(parseMcpTools([tool({ name: "send_sms" })])[0].effect).toBe("external");
  });
  it("rejects duplicates and bad input", () => {
    expect(() => parseMcpTools([tool({}), tool({})])).toThrow(/Duplicate/);
    expect(() => parseMcpTools("not json")).toThrow(/invalid JSON/);
    expect(() => parseMcpTools({ result: {} })).toThrow(/expected/);
    expect(() => parseMcpTools([])).toThrow(/no tools/);
    expect(() => parseMcpTools([tool({ name: "" })])).toThrow(/empty/);
  });
});
