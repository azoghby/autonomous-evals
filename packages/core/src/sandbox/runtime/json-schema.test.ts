import { describe, expect, it } from "vitest";
import { coerceObjectArgs, validateJsonSchema } from "./json-schema.js";

const errs = (schema: Record<string, unknown>, value: unknown): string[] => {
  const r = validateJsonSchema(schema, value);
  return r.ok ? [] : r.errors;
};
const ok = (schema: Record<string, unknown>, value: unknown) => expect(errs(schema, value)).toEqual([]);
const bad = (schema: Record<string, unknown>, value: unknown) => expect(errs(schema, value).length).toBeGreaterThan(0);

describe("validateJsonSchema", () => {
  it("empty and boolean schemas", () => {
    ok({}, { a: 1 });
    ok({}, null);
    expect(errs({ properties: { a: false } }, { a: 1 })).toEqual(["/a: not allowed"]);
    ok({ properties: { a: true } }, { a: 1 });
  });

  it("type checks", () => {
    expect(errs({ type: "integer" }, 1.5)).toEqual(["/: must be integer"]);
    ok({ type: "integer" }, 3);
    bad({ type: "number" }, Number.NaN);
    bad({ type: "number" }, Infinity);
    bad({ type: "string" }, 1);
    bad({ type: "object" }, []);
    bad({ type: "object" }, null);
    ok({ type: "array" }, []);
    ok({ type: "null" }, null);
    ok({ type: "boolean" }, false);
    ok({ type: ["string", "null"] }, null);
    expect(errs({ type: ["string", "null"] }, 1)).toEqual(["/: must be string or null"]);
  });

  it("nullable", () => {
    ok({ type: "string", nullable: true }, null);
    bad({ type: "string" }, null);
  });

  it("enum and const with deep equality", () => {
    ok({ enum: ["a", { x: [1] }] }, { x: [1] });
    bad({ enum: ["a", "b"] }, "c");
    ok({ const: { a: [1, 2] } }, { a: [1, 2] });
    bad({ const: { a: [1, 2] } }, { a: [2, 1] });
  });

  it("properties, required, additionalProperties with nested paths", () => {
    const s = {
      type: "object",
      required: ["a"],
      properties: { a: { type: "object", properties: { b: { type: "integer" } } } },
      additionalProperties: false,
    };
    expect(errs(s, {})).toEqual(["/a: is required"]);
    expect(errs(s, { a: { b: "x" } })).toEqual(["/a/b: must be integer"]);
    expect(errs(s, { a: {}, z: 1 })).toEqual(["/z: additional property not allowed"]);
    expect(errs({ additionalProperties: { type: "number" } }, { q: "s" })).toEqual(["/q: must be number"]);
  });

  it("items, minItems, maxItems, uniqueItems", () => {
    expect(errs({ items: { type: "string" } }, ["a", 2])).toEqual(["/1: must be string"]);
    bad({ minItems: 2 }, [1]);
    bad({ maxItems: 1 }, [1, 2]);
    bad({ uniqueItems: true }, [{ a: 1 }, { a: 1 }]);
    ok({ uniqueItems: true }, [1, "1", { a: 1 }, { a: 2 }]);
    ok({ items: [{ type: "string" }] }, [1]); // tuple form ignored
  });

  it("string lengths count code points", () => {
    ok({ maxLength: 1 }, "😀");
    bad({ maxLength: 1 }, "ab");
    bad({ minLength: 2 }, "😀");
  });

  it("pattern, invalid and overlong patterns", () => {
    ok({ pattern: "^a" }, "abc");
    bad({ pattern: "^a" }, "bc");
    expect(errs({ pattern: "(" }, "x")).toEqual(["/: invalid pattern"]);
    expect(errs({ pattern: "a".repeat(501) }, "a")).toEqual(["/: invalid pattern"]);
  });

  it("numeric bounds and multipleOf", () => {
    bad({ minimum: 1 }, 0);
    ok({ minimum: 1 }, 1);
    bad({ maximum: 1 }, 2);
    bad({ exclusiveMinimum: 1 }, 1);
    bad({ exclusiveMaximum: 1 }, 1);
    ok({ exclusiveMaximum: 1 }, 0.5);
    ok({ multipleOf: 0.01 }, 19.99);
    bad({ multipleOf: 5 }, 12);
  });

  it("formats", () => {
    ok({ format: "date" }, "2024-02-29");
    bad({ format: "date" }, "2023-02-29");
    ok({ format: "date-time" }, "2024-01-01T10:00:00Z");
    bad({ format: "date-time" }, "yesterday");
    ok({ format: "email" }, "a@b.co");
    bad({ format: "email" }, "nope");
    ok({ format: "uuid" }, "123e4567-e89b-12d3-a456-426614174000");
    bad({ format: "uuid" }, "123");
    ok({ format: "hostname-ish" }, "anything");
  });

  it("anyOf, oneOf, allOf, not", () => {
    ok({ anyOf: [{ type: "string" }, { type: "integer" }] }, 3);
    bad({ anyOf: [{ type: "string" }, { type: "integer" }] }, true);
    ok({ oneOf: [{ type: "string" }, { type: "number", minimum: 5 }] }, "a");
    bad({ oneOf: [{ type: "number" }, { minimum: 5 }] }, 7);
    expect(errs({ allOf: [{ type: "integer" }, { minimum: 3 }] }, 1)).toEqual(["/: must be >= 3"]);
    bad({ not: { type: "string" } }, "s");
    ok({ not: { type: "string" } }, 1);
  });

  it("local $ref and recursion guard", () => {
    const s = {
      $defs: { pos: { type: "integer", minimum: 1 } },
      definitions: { s: { type: "string" } },
      properties: { n: { $ref: "#/$defs/pos" }, t: { $ref: "#/definitions/s" } },
    };
    ok(s, { n: 2, t: "x" });
    expect(errs(s, { n: 0 })).toEqual(["/n: must be >= 1"]);
    expect(errs({ $ref: "#/$defs/missing" }, 1)[0]).toContain("unresolved");

    const tree = {
      $defs: { node: { type: "object", properties: { kids: { type: "array", items: { $ref: "#/$defs/node" } } } } },
      $ref: "#/$defs/node",
    };
    ok(tree, { kids: [{ kids: [] }] });
    expect(errs(tree, { kids: [{ kids: [{ kids: [1] }] }] })[0]).toBe("/kids/0/kids/0/kids/0: must be object");

    const loop = { $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" };
    expect(errs(loop, 1)[0]).toContain("recursion depth exceeded");
  });

  it("caps errors at 20", () => {
    const v = Array.from({ length: 50 }, () => "x");
    expect(errs({ items: { type: "integer" } }, v).length).toBe(20);
  });

  it("unknown keywords ignored", () => {
    ok({ foo: "bar", title: "t" }, 1);
  });

  it("realistic tool schema", () => {
    const s = {
      type: "object",
      properties: {
        order_id: { type: "string", pattern: "^ord_" },
        amount: { type: "number", minimum: 0 },
        reason: { enum: ["damaged", "late", "other"] },
      },
      required: ["order_id", "amount"],
      additionalProperties: false,
    };
    ok(s, { order_id: "ord_1", amount: 10.5, reason: "late" });
    expect(errs(s, { order_id: "x1", amount: -1, reason: "bored", extra: 1 })).toEqual([
      "/order_id: must match pattern ^ord_",
      "/amount: must be >= 0",
      expect.stringContaining("/reason: must be one of"),
      "/extra: additional property not allowed",
    ]);
    expect(errs(s, {})).toEqual(["/order_id: is required", "/amount: is required"]);
  });
});

describe("coerceObjectArgs", () => {
  it("passes plain objects", () => {
    const o = { a: 1 };
    expect(coerceObjectArgs(o)).toBe(o);
  });
  it("parses stringified objects", () => {
    expect(coerceObjectArgs('{"a":1}')).toEqual({ a: 1 });
  });
  it("rejects everything else", () => {
    expect(coerceObjectArgs("[1]")).toBeNull();
    expect(coerceObjectArgs("nope")).toBeNull();
    expect(coerceObjectArgs("3")).toBeNull();
    expect(coerceObjectArgs([1])).toBeNull();
    expect(coerceObjectArgs(null)).toBeNull();
    expect(coerceObjectArgs(5)).toBeNull();
  });
});
