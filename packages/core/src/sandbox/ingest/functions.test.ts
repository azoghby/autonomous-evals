import { describe, expect, it } from "vitest";
import { inferEffectFromName, parseFunctionTools } from "./functions";
import { PLACEHOLDER_BINDING } from "./types";

describe("parseFunctionTools", () => {
  it("parses OpenAI chat format", () => {
    const [t] = parseFunctionTools([{ type: "function", function: { name: "get_order", description: "d", parameters: { type: "object", properties: { id: { type: "string" } } } } }]);
    expect(t.name).toBe("get_order");
    expect(t.inputSchema).toEqual({ type: "object", properties: { id: { type: "string" } } });
    expect(t.source).toBe("json:get_order");
    expect(t.binding).toEqual(PLACEHOLDER_BINDING);
    expect(t.effect).toBe("read");
  });
  it("parses legacy and Responses formats", () => {
    const tools = parseFunctionTools([{ name: "a", parameters: { type: "object" } }, { type: "function", name: "b", parameters: { type: "object" } }]);
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(tools[1].inputSchema).toEqual({ type: "object" });
  });
  it("parses Anthropic format in {tools} wrapper from string", () => {
    const [t] = parseFunctionTools(JSON.stringify({ tools: [{ name: "x", description: "y", input_schema: { type: "object", properties: { a: {} } } }] }));
    expect(t.inputSchema).toEqual({ type: "object", properties: { a: {} } });
  });
  it("defaults schema and truncates description", () => {
    const [t] = parseFunctionTools([{ name: "n", description: "z".repeat(3000) }]);
    expect(t.inputSchema).toEqual({ type: "object", properties: {} });
    expect(t.description.length).toBe(2000);
  });
  it("sanitizes names", () => {
    expect(parseFunctionTools([{ name: "my-tool.v2" }])[0].name).toBe("my_tool_v2");
    expect(parseFunctionTools([{ name: "1abc" }])[0].name).toBe("_1abc");
    expect(parseFunctionTools([{ name: "a".repeat(100) }])[0].name).toHaveLength(64);
  });
  it("infers effects", () => {
    expect(inferEffectFromName("send_email")).toBe("external");
    expect(inferEffectFromName("charge_card")).toBe("external");
    expect(inferEffectFromName("list_orders")).toBe("read");
    expect(inferEffectFromName("refund_order")).toBe("write");
  });
  it("rejects duplicates", () => {
    expect(() => parseFunctionTools([{ name: "a" }, { name: "a" }])).toThrow(/Duplicate/);
  });
  it("rejects bad input", () => {
    expect(() => parseFunctionTools("{nope")).toThrow(/invalid JSON/);
    expect(() => parseFunctionTools({ foo: 1 })).toThrow(/expected an array/);
    expect(() => parseFunctionTools([])).toThrow(/no tools/);
    expect(() => parseFunctionTools([{ name: "" }])).toThrow(/empty/);
    expect(() => parseFunctionTools([{ name: "!!!" }])).toThrow(/empty/);
    expect(() => parseFunctionTools([{ description: "x" }])).toThrow(/name/);
    expect(() => parseFunctionTools([5])).toThrow(/not an object/);
  });
});
