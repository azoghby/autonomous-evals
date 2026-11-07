import { describe, expect, it } from "vitest";
import { normalizeInstructions, normalizeTrace } from "../normalize";
import { detect } from "../detect";

describe("normalization security regressions", () => {
  const secret = 'pa"ss\\word12345';
  it.each([
    [{ role: "assistant", content: `Echo ${secret}` }],
    { messages: [{ role: "assistant", content: [{ type: "text", text: secret }] }] },
    [{ role: "assistant", tool_calls: [{ id: "c1", function: { name: "test", arguments: JSON.stringify({ value: secret }) } }] }],
    [{ type: "function_call_output", output: { note: secret } }],
    [{ type: "function_call", name: "test", arguments: JSON.stringify({ note: secret }) }],
    [{ type: "tool_result", output: { note: secret } }],
    [{ role: "tool", content: [{ type: "text", text: secret }] }],
    [{ role: "assistant", content: [{ type: "tool_use", name: "test", input: { note: secret } }] }],
    { system: secret, messages: [{ role: "assistant", content: "hello" }] },
    [{ role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: secret }] }] }],
  ])("D2: redacts known secrets after decoding each JSON event shape", (trace) => {
    const normalized = normalizeTrace(JSON.stringify(trace), "auto", [secret]);
    expect(JSON.stringify(normalized.events)).not.toContain("word12345");
    expect(normalized.redactions).toBeGreaterThan(0);
  });

  it("D2: supports JSONL and text while keeping old calls valid", () => {
    const jsonl = [{ role: "user", content: secret }, { role: "assistant", content: "hello" }].map((e) => JSON.stringify(e)).join("\n");
    expect(normalizeTrace(jsonl, "jsonl", [secret]).events[0]!.text).toBe("[REDACTED]");
    expect(normalizeTrace(`ASSISTANT: ${secret}`, "text", [secret]).events[0]!.text).toBe("[REDACTED]");
    expect(normalizeTrace("ASSISTANT: hello").events[0]!.text).toBe("hello");
  });

  it("D3: redacts complete tokens before clipping a long event", () => {
    const text = "x".repeat(19_990) + "sk-ant-" + "a1B2".repeat(20);
    const result = normalizeTrace(JSON.stringify([{ role: "assistant", content: text }]));
    expect(result.events[0]!.text).toBe("x".repeat(19_990) + "[REDACTED]");
    expect(result.events[0]!.redactions).toBe(1);
  });

  it("D3: clips sanitized event text and warns, even when the secret is past the boundary", () => {
    const text = "x".repeat(20_001) + "DB_PASSWORD=verysecret";
    const result = normalizeTrace(JSON.stringify([{ role: "assistant", content: text }]));
    expect(result.events[0]!.text).toBe("x".repeat(20_000) + "…[clipped]");
    expect(result.redactions).toBe(1);
    expect(result.warnings).toContain("event 1 clipped to 20000 characters");
  });

  it("D3: redacts before bounding instructions too", () => {
    const result = normalizeInstructions("x".repeat(19_990) + "sk-ant-" + "a".repeat(40));
    expect(result.text).not.toContain("sk-ant-");
    expect(result.redactions).toBe(1);
  });
});

describe("D6: structured success and real failure evidence", () => {
  it.each([
    { status: "created", error: null }, { sent: 12, failed: 0 }, { error: false },
    { errors: [], failed: false }, { nested: { error: null, failure: 0 }, note: "created" },
    { error: "", errors: null },
  ])("ignores harmless error keys: %j", (payload) => {
    const text = JSON.stringify(payload);
    const trace = normalizeTrace(JSON.stringify([
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "send_batch", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: text },
      { role: "assistant", content: "All 12 messages were sent." },
    ]));
    expect(trace.events[1]).toMatchObject({ text, errorSignal: null });
    expect(detect(trace, null).candidates).toEqual([]);
  });

  it.each([
    [{ error: "smtp down" }, "explicit"], [{ ok: false, error: null }, "explicit"],
    [{ exit_code: 1 }, "explicit"], [{ status: 503 }, "explicit"],
    [{ note: "dependency unavailable" }, "pattern"], [{ errors: ["permission denied"] }, "pattern"],
    ["ERROR: connection refused", "explicit"], ["request failed", "pattern"],
    [{ ok: true, note: "no conflict" }, null],
  ])("retains failure signals and exact evidence for %j", (payload, expected) => {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    const trace = normalizeTrace(JSON.stringify([{ role: "tool", content: text }]));
    expect(trace.events[0]).toMatchObject({ text, errorSignal: expected });
  });
});
