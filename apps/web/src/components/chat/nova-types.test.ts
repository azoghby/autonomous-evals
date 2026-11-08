import { describe, expect, it } from "vitest";
import { ATTACHMENT_MAX_BYTES, attachmentProblem, classifyAttachment } from "./nova-types";

const OPENAPI_YAML = "openapi: 3.0.0\ninfo:\n  title: x\npaths: {}\n";
const TOOLS_JSON = JSON.stringify({ tools: [{ name: "get_order" }] });

describe("classifyAttachment", () => {
  it("detects YAML and JSON OpenAPI specs", () => {
    expect(classifyAttachment("spec.yaml", OPENAPI_YAML)).toBe("openapi");
    expect(classifyAttachment("spec.json", '{"openapi":"3.1.0","paths":{}}')).toBe("openapi");
    expect(classifyAttachment("old.json", '{"swagger": "2.0"}')).toBe("openapi");
  });
  it("detects a schema by CREATE TABLE", () => {
    expect(classifyAttachment("schema.sql", "create table orders (id int);")).toBe("schema");
  });
  it("rejects .sql files with no CREATE TABLE", () => {
    expect(classifyAttachment("seed.sql", "INSERT INTO orders VALUES (1);")).toBeNull();
  });
  it("detects an MCP tool list as an array or {tools: []}", () => {
    expect(classifyAttachment("tools.json", TOOLS_JSON)).toBe("tools");
    expect(classifyAttachment("tools.json", '[{"name":"a"}]')).toBe("tools");
  });
  it("rejects empty tool lists and invalid JSON", () => {
    expect(classifyAttachment("tools.json", '{"tools": []}')).toBeNull();
    expect(classifyAttachment("tools.json", "{not json")).toBeNull();
  });
  it("treats .md and .txt as policies", () => {
    expect(classifyAttachment("policy.md", "# Refunds\nNo refunds after 30 days.")).toBe("policies");
    expect(classifyAttachment("rules.txt", "be nice")).toBe("policies");
  });
  it("returns null for unknown files", () => {
    expect(classifyAttachment("notes.docx", "hello")).toBeNull();
  });
});

describe("attachmentProblem", () => {
  it("flags an empty file", () => {
    expect(attachmentProblem({ kind: "policies", name: "p.md", content: "" })).toBe("p.md is empty.");
  });
  it("flags an oversize file using the per-kind cap", () => {
    const content = "x".repeat(ATTACHMENT_MAX_BYTES.policies + 1);
    expect(attachmentProblem({ kind: "policies", name: "big.md", content })).toMatch(/big\.md is 21 KB.*at most 20 KB/);
  });
  it("counts bytes, not characters", () => {
    const content = "é".repeat(ATTACHMENT_MAX_BYTES.policies / 2 + 1);
    expect(attachmentProblem({ kind: "policies", name: "u.md", content })).toMatch(/at most 20 KB/);
  });
  it("flags a file whose detected kind differs from the declared kind", () => {
    expect(attachmentProblem({ kind: "openapi", name: "tools.json", content: TOOLS_JSON })).toMatch(/doesn't look like openapi spec/);
  });
  it("accepts a matching openapi, tools and schema file", () => {
    expect(attachmentProblem({ kind: "openapi", name: "spec.yaml", content: OPENAPI_YAML })).toBeNull();
    expect(attachmentProblem({ kind: "tools", name: "tools.json", content: TOOLS_JSON })).toBeNull();
    expect(attachmentProblem({ kind: "schema", name: "s.sql", content: "CREATE TABLE t (id int);" })).toBeNull();
  });
  it("always accepts policies by kind regardless of name or content shape", () => {
    expect(attachmentProblem({ kind: "policies", name: "weird.bin", content: "anything goes" })).toBeNull();
  });
});
