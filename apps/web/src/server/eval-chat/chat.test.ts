import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { EvalUIMessage } from "@/lib/eval-chat/types";
import { MAX_MESSAGE_CHARS, streamCopilotTurn, toUserMessage, turnCost, type ChatDeps } from "./chat";
import { OTHER_OWNER, OWNER, RUN_ID, SC_FLAKY, makeDeps, sandboxCtx } from "./fixtures.testing";

const text = (m: EvalUIMessage) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

describe("toUserMessage", () => {
  const ok = (raw: unknown) => toUserMessage(raw) as { ok: true; message: EvalUIMessage };
  it("accepts a user text message and assigns a server-side id and timestamp", () => {
    const r = ok({ role: "user", parts: [{ type: "text", text: "  why did it fail?  " }] });
    expect(r.ok).toBe(true);
    expect(r.message).toMatchObject({ role: "user", parts: [{ type: "text", text: "why did it fail?" }] });
    expect(r.message.id).toMatch(/^msg_[0-9a-f-]{36}$/);
    expect(r.message.metadata?.createdAt).toEqual(expect.any(String));
  });
  it("ignores a client-supplied id (ids are server-owned)", () => {
    const r = ok({ id: "msg_attacker", role: "user", parts: [{ type: "text", text: "hi" }] });
    expect(r.message.id).not.toBe("msg_attacker");
  });
  it("assigns a fresh id each time", () => {
    const m = { role: "user", parts: [{ type: "text", text: "hi" }] };
    expect(ok(m).message.id).not.toBe(ok(m).message.id);
  });
  it("joins multiple text parts", () => {
    expect(text(ok({ role: "user", parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }).message)).toBe("a\nb");
  });
  it.each(["assistant", "system", "tool"])("rejects the %s role", (role) => {
    expect(toUserMessage({ role, parts: [{ type: "text", text: "hi" }] })).toEqual({ ok: false, error: "Send a text message." });
  });
  it("rejects tool parts, file parts and unknown part types", () => {
    for (const part of [{ type: "tool-propose_rerun", toolCallId: "x", state: "output-available", input: {}, output: {} }, { type: "file", url: "x", mediaType: "a/b" }, { type: "reasoning", text: "x" }]) {
      expect(toUserMessage({ role: "user", parts: [{ type: "text", text: "hi" }, part] }).ok).toBe(false);
    }
  });
  it("rejects empty and whitespace-only messages and empty part lists", () => {
    expect(toUserMessage({ role: "user", parts: [{ type: "text", text: "   \n " }] }).ok).toBe(false);
    expect(toUserMessage({ role: "user", parts: [] }).ok).toBe(false);
    expect(toUserMessage({ role: "user" }).ok).toBe(false);
  });
  it("rejects more than four parts", () => {
    expect(toUserMessage({ role: "user", parts: Array.from({ length: 5 }, () => ({ type: "text", text: "x" })) }).ok).toBe(false);
  });
  it("rejects oversized text but accepts exactly the limit", () => {
    const over = toUserMessage({ role: "user", parts: [{ type: "text", text: "x".repeat(MAX_MESSAGE_CHARS + 1) }] });
    expect(over).toMatchObject({ ok: false, error: expect.stringContaining(String(MAX_MESSAGE_CHARS)) });
    expect(toUserMessage({ role: "user", parts: [{ type: "text", text: "x".repeat(MAX_MESSAGE_CHARS) }] }).ok).toBe(true);
  });
  it("rejects non-objects", () => {
    for (const raw of [null, undefined, "hi", 3, []]) expect(toUserMessage(raw).ok).toBe(false);
  });
});

describe("turnCost", () => {
  it("prefers the gateway-reported cost summed over steps", () => {
    const c = turnCost([{ providerMetadata: { gateway: { cost: "0.002" } } }, { providerMetadata: { gateway: { cost: 0.001 } } }], { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(c).toMatchObject({ microUsd: 3_000, basis: "gateway_reported" });
  });
  it("falls back to list price (sonnet: $2 in / $10 out per MTok)", () => {
    expect(turnCost([{}], { inputTokens: 1_000, outputTokens: 500 })).toEqual({ microUsd: 7_000, inputTokens: 1_000, outputTokens: 500, basis: "list_price_estimate" });
  });
  it("ignores unparsable gateway costs and is zero without usage", () => {
    expect(turnCost([{ providerMetadata: { gateway: { cost: "n/a" } } }], {})).toMatchObject({ microUsd: 0, basis: "list_price_estimate" });
  });
});

/* ---------------- streamCopilotTurn with a mock model ---------------- */

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
const finish = (reason: "stop" | "tool-calls", input: number, output: number) =>
  ({ type: "finish" as const, finishReason: { unified: reason, raw: undefined }, usage: usage(input, output) });
const reply = (words: string, input = 1_000, output = 500) => ({
  stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "t1" }, { type: "text-delta" as const, id: "t1", delta: words }, { type: "text-end" as const, id: "t1" },
    finish("stop", input, output),
  ] }),
});
const toolStep = (toolName: string, input: unknown, usageIn = 1_000, usageOut = 500) => ({
  stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    { type: "tool-call" as const, toolCallId: "call_1", toolName, input: JSON.stringify(input) },
    finish("tool-calls", usageIn, usageOut),
  ] }),
});

let t: ReturnType<typeof makeDeps>;
let recordCost: ReturnType<typeof vi.fn>;
const chatDeps = (model: MockLanguageModelV4, over: Partial<ChatDeps> = {}): ChatDeps => ({ ...t.deps, model, recordCost, ...over });
const userMsg = (s: string): EvalUIMessage => (toUserMessage({ role: "user", parts: [{ type: "text", text: s }] }) as { ok: true; message: EvalUIMessage }).message;
const promptText = (call: { prompt: Array<{ role: string; content: unknown }> }, role: string) =>
  call.prompt.filter((m) => m.role === role).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

beforeEach(() => { t = makeDeps(); recordCost = vi.fn(async () => {}); });
afterEach(() => vi.restoreAllMocks());

describe("streamCopilotTurn", () => {
  it("persists the user message and the assistant reply to the owner's thread", async () => {
    const model = new MockLanguageModelV4({ doStream: [reply("It skipped identity verification.")] });
    const res = await streamCopilotTurn(chatDeps(model), sandboxCtx(), userMsg("why did it fail?"));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.text();
    const saved = await t.store.loadMessages(OWNER, { kind: "sandbox_run", id: RUN_ID });
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(text(saved[0])).toBe("why did it fail?");
    expect(text(saved[1])).toBe("It skipped identity verification.");
    expect(await t.store.loadMessages(OTHER_OWNER, { kind: "sandbox_run", id: RUN_ID })).toEqual([]);
  });

  it("the model sees the stored history plus the new message, with the grounded system prompt", async () => {
    const ref = { kind: "sandbox_run" as const, id: RUN_ID };
    await t.store.saveMessages(OWNER, ref, [
      { id: "m_old_u", role: "user", parts: [{ type: "text", text: "EARLIER-QUESTION" }] },
      { id: "m_old_a", role: "assistant", parts: [{ type: "text", text: "EARLIER-ANSWER" }] },
    ]);
    await t.store.saveMessages(OTHER_OWNER, ref, [{ id: "m_other", role: "user", parts: [{ type: "text", text: "OTHER-OWNERS-SECRET-QUESTION" }] }]);
    const model = new MockLanguageModelV4({ doStream: [reply("ok")] });
    await (await streamCopilotTurn(chatDeps(model), sandboxCtx(), userMsg("NEW-QUESTION"))).text();
    const call = model.doStreamCalls[0] as unknown as { prompt: Array<{ role: string; content: unknown }> };
    const users = promptText(call, "user");
    expect(users).toContain("EARLIER-QUESTION");
    expect(users).toContain("NEW-QUESTION");
    expect(promptText(call, "assistant")).toContain("EARLIER-ANSWER");
    expect(JSON.stringify(call.prompt)).not.toContain("OTHER-OWNERS-SECRET-QUESTION");
    const system = promptText(call, "system");
    expect(system).toContain("<eval_data>");
    expect(system).toContain("Refund with identity check");
    expect(call.prompt[0].role).toBe("system");
  });

  it("only the server-stored history reaches the model: the function takes just the new message", async () => {
    expect(streamCopilotTurn.length).toBeLessThanOrEqual(4);
    const model = new MockLanguageModelV4({ doStream: [reply("ok")] });
    await (await streamCopilotTurn(chatDeps(model), sandboxCtx(), userMsg("only this"))).text();
    const call = model.doStreamCalls[0] as unknown as { prompt: Array<{ role: string; content: unknown }> };
    expect(call.prompt.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("records cost with a positive microUsd from reported usage", async () => {
    const model = new MockLanguageModelV4({ doStream: [reply("ok", 1_000, 500)] });
    await (await streamCopilotTurn(chatDeps(model), sandboxCtx(), userMsg("hi"))).text();
    expect(recordCost).toHaveBeenCalledTimes(1);
    const entry = recordCost.mock.calls[0][0] as { ownerId: string; microUsd: number; inputTokens: number; outputTokens: number; basis: string; ctx: { ref: { id: string } } };
    expect(entry).toMatchObject({ ownerId: OWNER, microUsd: 7_000, inputTokens: 1_000, outputTokens: 500, basis: "list_price_estimate" });
    expect(entry.ctx.ref.id).toBe(RUN_ID);
  });

  it("a failing cost recorder does not break the reply", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    recordCost.mockRejectedValue(new Error("db down"));
    const model = new MockLanguageModelV4({ doStream: [reply("still answered")] });
    const out = await (await streamCopilotTurn(chatDeps(model), sandboxCtx(), userMsg("hi"))).text();
    expect(out).toContain("still answered");
  });

  it("does not record a cost when no usage is reported", async () => {
    const model = new MockLanguageModelV4({ doStream: [reply("ok", 0, 0)] });
    await (await streamCopilotTurn(chatDeps(model), sandboxCtx(), userMsg("hi"))).text();
    expect(recordCost).not.toHaveBeenCalled();
  });

  it("a model-requested tool call executes against the bound context and its card is persisted", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep("explain_failure", { scenarioId: SC_FLAKY }), reply("It refunded before verifying.")] });
    const out = await (await streamCopilotTurn(chatDeps(model), sandboxCtx(), userMsg("why did the identity one fail?"))).text();
    expect(out).toContain("tool-output-available");
    const [, assistant] = await t.store.loadMessages(OWNER, { kind: "sandbox_run", id: RUN_ID });
    const part = assistant.parts.find((p) => p.type === "tool-explain_failure") as unknown as { state: string; output: { scenarioId: string; trial: number; failedChecks: Array<{ id: string }> } };
    expect(part.state).toBe("output-available");
    expect(part.output).toMatchObject({ scenarioId: SC_FLAKY, trial: 2 });
    expect(part.output.failedChecks.map((c) => c.id)).toEqual(["verify_first"]);
    expect(text(assistant)).toContain("It refunded before verifying.");
    // The second model step saw the tool result.
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain("verify_first");
  });

  it("cost is recorded per step (so an abort cannot skip it) and sums to the turn's usage", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep("get_overview", {}, 1_000, 500), reply("done", 1_000, 500)] });
    await (await streamCopilotTurn(chatDeps(model), sandboxCtx(), userMsg("overview"))).text();
    expect(recordCost).toHaveBeenCalledTimes(2);
    const total = recordCost.mock.calls.reduce((n: number, c: Array<{ microUsd: number }>) => n + c[0].microUsd, 0);
    expect(total).toBe(14_000);
  });

  it("refuses a turn once the owner's daily copilot allowance is spent, before calling the model", async () => {
    const model = new MockLanguageModelV4({ doStream: [reply("hi", 10, 10)] });
    const deps = { ...chatDeps(model), spentTodayMicroUsd: async () => 5_000_000 };
    await expect(streamCopilotTurn(deps, sandboxCtx(), userMsg("hello"))).rejects.toThrow(/allowance/);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("only one paid scenario generation is proposed per message", async () => {
    const model = new MockLanguageModelV4({ doStream: [
      toolStep("propose_add_scenario", { brief: "Customer asks for a refund over the limit", category: "boundary" }),
      toolStep("propose_add_scenario", { brief: "Customer asks for a second refund over the limit", category: "boundary" }),
      reply("One at a time.", 10, 10),
    ] });
    await (await streamCopilotTurn(chatDeps(model), sandboxCtx(), userMsg("add two scenarios"))).text();
    expect(t.sandbox.seedSuiteFromRun).toHaveBeenCalledTimes(1);
  });

  it("a proposal tool call stores a pending action and does not execute anything", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep("propose_rerun", { scope: "failed", k: 3 }), reply("Press Confirm to start.")] });
    await (await streamCopilotTurn(chatDeps(model), sandboxCtx(), userMsg("rerun the failures with k=3"))).text();
    expect([...t.store.actions.values()]).toHaveLength(1);
    expect([...t.store.actions.values()][0]).toMatchObject({ status: "proposed", kind: "rerun", payload: { k: 3 } });
    expect(t.sandbox.startRun).not.toHaveBeenCalled();
  });

  it("a tool error is returned to the model instead of failing the turn", async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep("explain_failure", { scenarioId: "sx_nope" }), reply("That scenario does not exist.")] });
    const out = await (await streamCopilotTurn(chatDeps(model), sandboxCtx(), userMsg("why?"))).text();
    expect(out).toContain("tool-output-error");
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain("No scenario");
    expect(out).toContain("That scenario does not exist.");
  });

  it("retrying the same question after a failed turn does not store the user message twice", async () => {
    const ref = { kind: "sandbox_run" as const, id: RUN_ID };
    await t.store.saveMessages(OWNER, ref, [{ id: "m_first", role: "user", parts: [{ type: "text", text: "why did it fail?" }] }]);
    const model = new MockLanguageModelV4({ doStream: [reply("Because.")] });
    await (await streamCopilotTurn(chatDeps(model), sandboxCtx(), userMsg("why did it fail?"))).text();
    const saved = await t.store.loadMessages(OWNER, ref);
    expect(saved.filter((m) => m.role === "user")).toHaveLength(1);
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant"]);
    const call = model.doStreamCalls[0] as unknown as { prompt: Array<{ role: string }> };
    expect(call.prompt.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("a model failure yields a safe error and still keeps the user message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const model = new MockLanguageModelV4({ doStream: async () => { throw new Error("gateway key sk-secret exploded"); } });
    const out = await (await streamCopilotTurn(chatDeps(model), sandboxCtx(), userMsg("hi"))).text();
    expect(out).toContain("could not answer just now");
    expect(out).not.toContain("sk-secret");
    expect((await t.store.loadMessages(OWNER, { kind: "sandbox_run", id: RUN_ID })).map((m) => m.role)).toEqual(["user"]);
  });
});
