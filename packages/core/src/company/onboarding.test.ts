import { describe, expect, it } from "vitest";
import {
  appendTranscript, artifactsToRequirements, computeMissing, detectSecrets, EMPTY_REQUIREMENTS, estimateRunMicroUsd, isReady,
  mergeRequirements, planRunSize, sniffArtifacts, MAX_TRANSCRIPT_ENTRIES, ONBOARDING_MAX_SCENARIOS,
} from "./onboarding";

const MODELS = ["openai/gpt-5-mini"] as const;

describe("mergeRequirements", () => {
  it("overlays new facts without erasing and without mutating", () => {
    const prev = mergeRequirements(undefined, { agent: { model: "openai/gpt-5-mini" } });
    const frozen = JSON.stringify(prev);
    const next = mergeRequirements(prev, { agent: { systemPrompt: "Be helpful", model: "" }, tools: { prebuiltWorld: "acme-support" } });
    expect(next.agent).toEqual({ model: "openai/gpt-5-mini", systemPrompt: "Be helpful" });
    expect(next.tools.prebuiltWorld).toBe("acme-support");
    expect(JSON.stringify(prev)).toBe(frozen);
  });
  it("appends distinct policies once", () => {
    const a = mergeRequirements(EMPTY_REQUIREMENTS, { policies: "Refund within 30 days" });
    const b = mergeRequirements(a, { policies: "Refund within 30 days" });
    const c = mergeRequirements(b, { policies: "Escalate fraud" });
    expect(b.policies).toBe("Refund within 30 days");
    expect(c.policies).toBe("Refund within 30 days\n\nEscalate fraud");
  });
});

describe("detectSecrets", () => {
  it("flags and redacts keys", () => {
    const r = detectSecrets("here is my key sk-abcdefghijklmnopqrstuvwxyz123456 thanks\nsecond line ok");
    expect(r.hasSecret).toBe(true);
    expect(r.redacted).not.toContain("sk-abcdef");
    expect(r.redacted).toContain("second line ok");
  });
  it("flags api_key assignments and private keys", () => {
    expect(detectSecrets("API_KEY=abcdef1234567890xyz").hasSecret).toBe(true);
    expect(detectSecrets("-----BEGIN PRIVATE KEY-----").hasSecret).toBe(true);
  });
  it("passes clean text", () => {
    const r = detectSecrets("our endpoint is https://agent.acme.com/v1");
    expect(r).toEqual({ hasSecret: false, redacted: "our endpoint is https://agent.acme.com/v1" });
  });
});

describe("sniffArtifacts", () => {
  it("extracts fenced openapi, tools json and ddl, leaving placeholders", () => {
    const text = "spec:\n```yaml\nopenapi: 3.0.0\ninfo: {}\n```\ntools:\n```json\n[{\"name\":\"a\"}]\n```\n```sql\nCREATE TABLE t (id int);\n```\nthanks";
    const { cleaned, found } = sniffArtifacts(text);
    expect(found.openapiText).toContain("openapi: 3.0.0");
    expect(found.mcpToolsJson).toBe("[{\"name\":\"a\"}]");
    expect(found.dataSample).toContain("CREATE TABLE");
    expect(cleaned).not.toContain("openapi: 3.0.0");
    expect(cleaned).toContain("thanks");
    expect(artifactsToRequirements(found).tools?.openapiText).toBeDefined();
  });
  it("leaves ordinary code fences alone", () => {
    const t = "```js\nconsole.error(1)\n```";
    expect(sniffArtifacts(t)).toEqual({ cleaned: t, found: {} });
  });
});

describe("readiness", () => {
  it("needs an agent target and tools", () => {
    expect(computeMissing(EMPTY_REQUIREMENTS, { allowedModels: MODELS })).toHaveLength(2);
  });
  it("accepts model+prompt with a prebuilt world", () => {
    const r = mergeRequirements(EMPTY_REQUIREMENTS, { agent: { model: "openai/gpt-5-mini", systemPrompt: "x" }, tools: { prebuiltWorld: "acme-support" } });
    expect(isReady(r, { allowedModels: MODELS })).toBe(true);
  });
  it("rejects http endpoints and unknown hosted models", () => {
    const http = mergeRequirements(EMPTY_REQUIREMENTS, { agent: { endpointUrl: "http://x.com" }, tools: { prebuiltWorld: "acme-support" } });
    expect(computeMissing(http)[0]).toMatch(/https/);
    const bad = mergeRequirements(EMPTY_REQUIREMENTS, { agent: { model: "foo/bar", systemPrompt: "x" }, tools: { prebuiltWorld: "acme-support" } });
    expect(computeMissing(bad, { allowedModels: MODELS })[0]).toMatch(/must be one of/);
  });
  it("an MCP url alone is not enough", () => {
    const r = mergeRequirements(EMPTY_REQUIREMENTS, { agent: { endpointUrl: "https://a.com/v1" }, tools: { mcpUrl: "https://a.com/mcp" } });
    expect(computeMissing(r)[0]).toMatch(/tools\/list/);
  });
});

describe("planRunSize", () => {
  it("fits the request when allowance is ample", () => {
    expect(planRunSize({ available: 10, headroomMicroUsd: null, runCapMicroUsd: 3_000_000 })).toMatchObject({ k: 3, scenarios: ONBOARDING_MAX_SCENARIOS, blocked: false });
  });
  it("shrinks to a capped allowance", () => {
    const p = planRunSize({ available: 6, headroomMicroUsd: 400_000, runCapMicroUsd: 3_000_000 });
    expect(p.blocked).toBe(false);
    expect(p.estimateMicroUsd).toBeLessThanOrEqual(400_000);
  });
  it("blocks when even one trial exceeds the allowance", () => {
    expect(planRunSize({ available: 4, headroomMicroUsd: 10_000, runCapMicroUsd: 3_000_000 }).blocked).toBe(true);
    expect(estimateRunMicroUsd(2, 3)).toBe(240_000);
  });
});

describe("appendTranscript", () => {
  it("trims to the max length immutably", () => {
    let t: ReturnType<typeof appendTranscript> = [];
    for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES + 5; i++) t = appendTranscript(t, { role: "customer", text: String(i), at: "x" });
    expect(t).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    expect(t.at(-1)?.text).toBe(String(MAX_TRANSCRIPT_ENTRIES + 4));
  });
});
