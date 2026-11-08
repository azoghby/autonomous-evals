import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSqlHints, parseOpenApi, parseYamlOrJson } from "./openapi";

const spec = {
  openapi: "3.0.0",
  paths: {
    "/orders/{id}": {
      get: {
        operationId: "get-order", summary: "Get order", description: "Fetch one.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" }, example: "o1" },
          { name: "expand", in: "query", description: "expand", schema: { type: "boolean", default: false } },
        ],
        responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } } },
        "x-sandbox-sql": { statements: ["select 1"], resultShape: "row", resultFrom: 0 },
      },
    },
    "/refunds": {
      post: {
        operationId: "create_refund",
        requestBody: { content: { "application/json": { schema: { type: "object", required: ["order_id"], properties: { order_id: { type: "string", example: "o1" }, node: { $ref: "#/components/schemas/Node" } } } } } },
        responses: { "201": { content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/mail": { post: { operationId: "send_email", responses: {} } },
    "/x": { post: { operationId: "do_thing", "x-effect": "external", responses: {} } },
  },
  components: { schemas: { Order: { type: "object", properties: { id: { type: "string" } } }, Node: { type: "object", properties: { next: { $ref: "#/components/schemas/Node" } } } } },
};

describe("parseOpenApi", () => {
  const tools = parseOpenApi(spec);
  const by = (n: string) => tools.find((t) => t.name === n)!;
  it("sanitizes names and sets source", () => {
    expect(by("get_order").source).toBe("openapi:GET /orders/{id}");
  });
  it("merges params and resolves refs", () => {
    const i = by("get_order").inputSchema as any;
    expect(i.required).toEqual(["id"]);
    expect(i.properties.id.example).toBe("o1");
    expect(i.properties.expand.default).toBe(false);
    expect((by("get_order").outputSchema as any).properties.id.type).toBe("string");
  });
  it("merges body props, keeps examples, is cycle-safe", () => {
    const i = by("create_refund").inputSchema as any;
    expect(i.required).toEqual(["order_id"]);
    expect(i.properties.order_id.example).toBe("o1");
    expect(i.properties.node.properties.next).toEqual({ type: "object" });
  });
  it("infers effects", () => {
    expect(by("get_order").effect).toBe("read");
    expect(by("create_refund").effect).toBe("write");
    expect(by("send_email").effect).toBe("external");
    expect(by("do_thing").effect).toBe("external");
  });
  it("throws on missing operationId", () => {
    expect(() => parseOpenApi({ paths: { "/a": { get: {} } } })).toThrow(/operationId/);
  });
  it("accepts YAML and JSON strings", () => {
    expect(parseOpenApi("openapi: 3.0.0\npaths:\n  /a:\n    get:\n      operationId: a\n")).toHaveLength(1);
    expect(parseYamlOrJson('{"a":1}')).toEqual({ a: 1 });
  });
});

describe("extractSqlHints", () => {
  it("maps operationId to hint", () => {
    expect(extractSqlHints(spec)).toEqual({ get_order: { statements: ["select 1"], resultFrom: 0, resultShape: "row" } });
  });
});

const acme = resolve(process.cwd(), "data/envs/acme-support/openapi.yaml");
describe.skipIf(!existsSync(acme))("acme-support spec", () => {
  it("parses 9 tools with expected effects", () => {
    const tools = parseOpenApi(readFileSync(acme, "utf8"));
    expect(tools.map((t) => t.name).sort()).toEqual(["create_refund", "create_ticket", "get_order", "list_orders", "lookup_customer", "search_kb", "send_email", "update_ticket", "verify_identity"]);
    const eff = Object.fromEntries(tools.map((t) => [t.name, t.effect]));
    expect(eff).toMatchObject({ send_email: "external", verify_identity: "read", search_kb: "read", get_order: "read", list_orders: "read", lookup_customer: "read", create_refund: "write", create_ticket: "write", update_ticket: "write" });
  });
});

describe("expansion bombs", () => {
  /** Each schema references the previous one fanout times: 4 levels x 40 refs expand to ~40^4 nodes from a few KB. */
  function refBomb(levels: number, fanout = 9) {
    const schemas: Record<string, unknown> = { s0: { type: "string" } };
    for (let i = 1; i <= levels; i++) {
      schemas[`s${i}`] = { type: "object", properties: Object.fromEntries(Array.from({ length: fanout }, (_, j) => [`p${j}`, { $ref: `#/components/schemas/s${i - 1}` }])) };
    }
    return { openapi: "3.0.0", components: { schemas }, paths: { "/x": { post: { operationId: "boom", requestBody: { content: { "application/json": { schema: { $ref: `#/components/schemas/s${levels}` } } } } } } } };
  }

  it("refuses a $ref fan-out bomb quickly with a clear error", () => {
    const t0 = Date.now();
    expect(() => parseOpenApi(refBomb(4, 40))).toThrow(/expands to more than 250,000 schema nodes/);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("refuses a YAML alias (billion laughs) bomb", () => {
    const lines = ["openapi: 3.0.0", "x0: &a0 {type: string}"];
    for (let i = 1; i <= 9; i++) lines.push(`x${i}: &a${i} {type: object, properties: {${Array.from({ length: 9 }, (_, j) => `p${j}: *a${i - 1}`).join(", ")}}}`);
    lines.push("paths:", "  /x:", "    post:", "      operationId: boom", "      requestBody:", "        content:", "          application/json:", "            schema: *a9");
    const yaml = lines.join("\n");
    expect(yaml.length).toBeLessThan(1_500);
    expect(() => parseOpenApi(yaml)).toThrow(/schema nodes/);
  });

  it("still resolves a modest shared schema used many times (memoised)", () => {
    const tools = parseOpenApi(refBomb(2));
    const props = (tools[0]!.inputSchema as { properties: Record<string, { properties: Record<string, unknown> }> }).properties;
    expect(Object.keys(props)).toHaveLength(9);
    expect(props.p0!.properties.p0).toEqual({ type: "string" });
  });
});
