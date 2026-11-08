import { describe, expect, it } from "vitest";
import { ChatTurnBody, customerLine, toAgentAttachments } from "./onboarding-chat-request";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const file = (kind: "openapi" | "tools" | "schema" | "policies", content: string, name = "f.txt") => ({ kind, name, content });
const parse = (b: unknown) => ChatTurnBody.safeParse(b);

describe("ChatTurnBody", () => {
  it("accepts a plain message and defaults attachments", () => {
    const r = parse({ message: "  hello  " });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ message: "hello", attachments: [] });
  });
  it("rejects an empty turn with no attachments, fields or action", () => {
    expect(parse({ message: "   " }).success).toBe(false);
    expect(parse({}).success).toBe(false);
  });
  it("accepts an action-only turn", () => {
    expect(parse({ action: "confirm" }).success).toBe(true);
    expect(parse({ action: "cancel" }).success).toBe(true);
  });
  it("rejects an unknown action", () => {
    expect(parse({ action: "nuke" }).success).toBe(false);
  });
  it("rejects a malformed conversation id and accepts a uuid", () => {
    expect(parse({ message: "hi", conversationId: "not-a-uuid" }).success).toBe(false);
    expect(parse({ message: "hi", conversationId: UUID }).success).toBe(true);
  });
  it("accepts a fields-only turn with an allowlisted model", () => {
    expect(parse({ fields: { model: "openai/gpt-5-mini" } }).success).toBe(true);
  });
  it("rejects a model outside the allowlist", () => {
    expect(parse({ fields: { model: "evil/model" } }).success).toBe(false);
  });
  it("rejects unknown field keys (strict)", () => {
    expect(parse({ message: "hi", fields: { model: "openai/gpt-5-mini", apiKey: "sk-x" } }).success).toBe(false);
  });
  it("rejects more than four attachments", () => {
    const five = Array.from({ length: 5 }, (_, i) => file("policies", "x", `f${i}.md`));
    expect(parse({ message: "hi", attachments: five }).success).toBe(false);
    expect(parse({ message: "hi", attachments: five.slice(0, 4) }).success).toBe(true);
  });
  it("accepts an attachment-only turn and rejects an empty attachment", () => {
    expect(parse({ attachments: [file("policies", "rule")] }).success).toBe(true);
    expect(parse({ attachments: [file("policies", "")] }).success).toBe(false);
  });
  it("rejects an invalid endpoint url", () => {
    expect(parse({ fields: { endpointUrl: "not a url" } }).success).toBe(false);
  });
});

describe("toAgentAttachments", () => {
  it("maps each kind to its artifact slot", () => {
    expect(toAgentAttachments([file("openapi", "O"), file("tools", "T"), file("schema", "S")])).toEqual({ openapiText: "O", mcpToolsJson: "T", dataSample: "S" });
  });
  it("concatenates multiple policies files", () => {
    expect(toAgentAttachments([file("policies", "A"), file("policies", "B")]).policies).toBe("A\n\nB");
  });
  it("takes the last file for non-policy kinds", () => {
    expect(toAgentAttachments([file("openapi", "first"), file("openapi", "second")]).openapiText).toBe("second");
  });
  it("returns an empty object for no files", () => {
    expect(toAgentAttachments([])).toEqual({});
  });
});

describe("customerLine", () => {
  const body = (b: unknown) => ChatTurnBody.parse(b);

  it("never includes file content and labels the attachment with kind and size", () => {
    const secretish = "SUPER-SECRET-BODY ".repeat(200);
    const line = customerLine(body({ message: "see attached", attachments: [file("openapi", secretish, "api.yaml")] }));
    expect(line).not.toContain("SUPER-SECRET-BODY");
    expect(line).toContain("[attached: api.yaml (OpenAPI spec, 4 KB)]");
    expect(line.startsWith("see attached")).toBe(true);
  });
  it("shows at least 1 KB for tiny files", () => {
    expect(customerLine(body({ attachments: [file("policies", "x", "p.md")] }))).toBe("[attached: p.md (Policies, 1 KB)]");
  });
  it("describes actions", () => {
    expect(customerLine(body({ action: "confirm" }))).toBe("Confirmed the run.");
    expect(customerLine(body({ action: "cancel" }))).toBe("Cancelled the run.");
  });
  it("describes picker fields without echoing the system prompt", () => {
    const line = customerLine(body({ fields: { model: "openai/gpt-5-mini", systemPrompt: "TOP SECRET PROMPT" } }));
    expect(line).toBe("Model: openai/gpt-5-mini (with a system prompt)");
    expect(customerLine(body({ fields: { systemPrompt: "x" } }))).toBe("Added a system prompt.");
  });
  it("describes endpoint and sample world", () => {
    const line = customerLine(body({ fields: { endpointUrl: "https://bot.example.com/chat", prebuiltWorld: "acme-support" } }));
    expect(line).toBe("Endpoint: https://bot.example.com/chat\nUse the Acme sample world.");
  });
});
