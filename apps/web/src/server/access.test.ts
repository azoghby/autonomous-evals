import { describe, expect, it } from "vitest";
import { canViewJob } from "./access";
import { extractLargeTrace, injectCredentials, stripCredentials, credentialSlotsOf } from "./intake";
import type { IntakeInput } from "@ae/core/contracts/index";

const owner = { id: "c1", email: "o@x.com", isOperator: false };
describe("canViewJob", () => {
  it("allows owner and operator, denies others and anonymous", () => {
    const job = { customerId: "c1" };
    expect(canViewJob(owner, job)).toBe(true);
    expect(canViewJob({ id: "c2", email: "x", isOperator: false }, job)).toBe(false);
    expect(canViewJob({ id: "c2", email: "x", isOperator: true }, job)).toBe(true);
    expect(canViewJob(null, job)).toBe(false);
    expect(canViewJob(owner, null)).toBe(false);
  });
});

describe("intake credential handling", () => {
  const intake = {
    package: "text_eval", authorizedToTest: true,
    endpoint: { url: "https://api.example.com/v1", model: "m", apiKey: "sk-123", systemPrompt: "" },
  } as unknown as IntakeInput;
  it("strips keys without mutating input and re-injects them", () => {
    const { sanitized, credentials } = stripCredentials(intake);
    expect(JSON.stringify(sanitized)).not.toContain("sk-123");
    expect(credentials).toEqual({ endpoint: "sk-123" });
    expect((intake as { endpoint: { apiKey: string } }).endpoint.apiKey).toBe("sk-123");
    expect(credentialSlotsOf(sanitized)).toEqual(["endpoint"]);
    expect((injectCredentials(sanitized, credentials).endpoint as { apiKey: string }).apiKey).toBe("sk-123");
  });
  it("moves only large traces out", () => {
    expect(extractLargeTrace({ trace: "small" }).trace).toBeNull();
    const big = "x".repeat(30_000);
    const r = extractLargeTrace({ trace: big, package: "trace_audit" });
    expect(r.trace).toBe(big);
    expect(r.intake).toEqual({ package: "trace_audit" });
  });
});
