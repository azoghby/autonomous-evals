import { describe, expect, it } from "vitest";
import { TargetError, type JsonTransport } from "../../targets/transport";
import { targetFromEnv, toolLoopAgent, toolsForOpenAI, type ToolLoopTarget } from "./driver";
import { FakeRuntime } from "./testing/fake-runtime";
import { miniEnv, miniWorld, refundScenario } from "./testing/fixtures";

const KEY = "sk-test-SECRETSECRETSECRET123";
const ENDPOINT = "https://agent.example.com/v1/chat/completions";
const target: ToolLoopTarget = { endpointUrl: ENDPOINT, model: "test-model", apiKey: KEY, systemPrompt: "You are support." };

const toolMsg = (id: string, name: string, args: string) => ({
  choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] }, finish_reason: "tool_calls" }],
});
const finalMsg = (content: string) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });

interface Posted { endpoint: string; body: { messages: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> }; bearer?: string }
function scripted(responses: Array<unknown | (() => never)>) {
  const posted: Posted[] = [];
  const transport: JsonTransport = {
    async post(endpoint, body, bearer) {
      posted.push({ endpoint, body: structuredClone(body) as Posted["body"], bearer });
      const r = responses[Math.min(posted.length - 1, responses.length - 1)];
      if (typeof r === "function") return (r as () => never)();
      return r;
    },
  };
  return { transport, posted };
}

async function setup(responses: Array<unknown | (() => never)>, opts: Parameters<typeof toolLoopAgent>[1] = {}, tgt = target) {
  const rt = new FakeRuntime(miniWorld);
  const { worldId } = await rt.prepare(miniEnv, "j1");
  const run = await rt.startRun(worldId, miniEnv, refundScenario, 0);
  const s = scripted(responses);
  const factory = toolLoopAgent(tgt, { transport: s.transport, ...opts });
  const session = factory.start({ env: miniEnv, scenario: refundScenario, run });
  return { run, session, factory, ...s };
}

describe("toolsForOpenAI", () => {
  it("emits OpenAI function tools, strips $schema, ensures object/properties", () => {
    const tools = toolsForOpenAI([
      { ...miniEnv.tools[0]!, inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } } } },
      { ...miniEnv.tools[1]!, inputSchema: {} },
    ]);
    expect(tools[0]).toMatchObject({ type: "function", function: { name: "verify_identity", parameters: { type: "object", properties: { a: { type: "string" } } } } });
    expect(tools[0]!.function.parameters).not.toHaveProperty("$schema");
    expect(tools[1]!.function.parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("targetFromEnv", () => {
  it("maps tool_loop integration", () => {
    expect(targetFromEnv(miniEnv, KEY)).toEqual({ endpointUrl: ENDPOINT, model: "test-model", apiKey: KEY });
  });
  it("throws for other modes", () => {
    const env = { ...miniEnv, integration: { mode: "staging" as const, chatEndpointUrl: "https://x.example.com/c" } };
    expect(() => targetFromEnv(env)).toThrow("unsupported integration mode: staging");
  });
});

describe("toolLoopAgent", () => {
  it("runs the tool loop, records trajectory and feeds tool results back", async () => {
    const t = await setup([
      toolMsg("c1", "verify_identity", '{"customer_id":"c_1","email":"ann@example.com"}'),
      toolMsg("c2", "refund_order", '{"order_id":"o_100","amount":47.2}'),
      finalMsg("Refunded $47.20"),
    ]);
    expect(t.factory.name).toBe("tool_loop:test-model");
    const turn = await t.session.send("Please refund o_100");
    expect(turn.error).toBeUndefined();
    expect(turn.reply).toBe("Refunded $47.20");
    expect(turn.costMicroUsd).toBe(0);
    expect(turn.transcript.map((e) => e.role)).toEqual(["tool", "tool", "assistant"]);
    expect(turn.transcript[0]!.content).toContain("verify_identity(");
    expect(t.run.trajectory().map((r) => r.tool)).toEqual(["verify_identity", "refund_order"]);

    expect(t.posted).toHaveLength(3);
    expect(t.posted[0]!.bearer).toBe(KEY);
    expect(t.posted[0]!.body.tools).toHaveLength(miniEnv.tools.length);
    expect(t.posted[0]!.body.tools![0]).toMatchObject({ type: "function", function: { name: "verify_identity" } });
    expect(t.posted[0]!.body.messages[0]).toEqual({ role: "system", content: "You are support." });
    const last = t.posted[1]!.body.messages.at(-1)!;
    expect(last).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(JSON.parse(last.content as string)).toEqual({ id: "c_1" });
  });

  it("keeps history across turns", async () => {
    const t = await setup([finalMsg("one"), finalMsg("two")]);
    await t.session.send("a");
    await t.session.send("b");
    const roles = t.posted[1]!.body.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
  });

  it("returns invalid_arguments_json to the model without calling the run", async () => {
    const t = await setup([toolMsg("c1", "lookup_order", "{not json"), finalMsg("ok")]);
    const turn = await t.session.send("hi");
    expect(turn.error).toBeUndefined();
    expect(t.run.trajectory()).toHaveLength(0);
    expect(t.posted[1]!.body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1", content: '{"error":"invalid_arguments_json"}' });
  });

  it("passes tool errors back as {error}", async () => {
    const t = await setup([toolMsg("c1", "lookup_order", '{"order_id":"nope"}'), finalMsg("not found")]);
    await t.session.send("hi");
    expect(JSON.parse(t.posted[1]!.body.messages.at(-1)!.content as string)).toEqual({ error: "not_found" });
  });

  it("enforces the step limit", async () => {
    const t = await setup([toolMsg("c1", "lookup_order", '{"order_id":"o_100"}')], { maxStepsPerTurn: 3 });
    const turn = await t.session.send("hi");
    expect(turn.error).toBe("tool_loop_limit");
    expect(t.posted).toHaveLength(3);
  });

  it("enforces the tool-call limit", async () => {
    const t = await setup([toolMsg("c1", "lookup_order", '{"order_id":"o_100"}')], { maxToolCallsPerTurn: 2 });
    const turn = await t.session.send("hi");
    expect(turn.error).toBe("tool_loop_limit");
    expect(t.run.trajectory()).toHaveLength(2);
  });

  it("maps transport errors to their code", async () => {
    const t = await setup([() => { throw new TargetError("provider_http_error"); }]);
    const turn = await t.session.send("hi");
    expect(turn).toMatchObject({ reply: "", error: "provider_http_error", costMicroUsd: 0 });
  });

  it("maps unknown errors to target_error and bad responses to invalid_completion", async () => {
    const a = await setup([() => { throw new Error("boom"); }]);
    expect((await a.session.send("hi")).error).toBe("target_error");
    const b = await setup([{ nope: true }]);
    expect((await b.session.send("hi")).error).toBe("invalid_completion");
  });

  it("rejects bad endpoints before any request", async () => {
    const t = await setup([finalMsg("x")], {}, { ...target, endpointUrl: "http://agent.example.com/v1" });
    expect((await t.session.send("hi")).error).toBe("invalid_endpoint");
    const p = await setup([finalMsg("x")], {}, { ...target, endpointUrl: "https://10.0.0.1/v1" });
    expect((await p.session.send("hi")).error).toBe("blocked_address");
    expect(t.posted).toHaveLength(0);
    expect(p.posted).toHaveLength(0);
  });

  it("retries target_busy then succeeds", async () => {
    const t = await setup([() => { throw new TargetError("target_busy"); }, finalMsg("done")]);
    const turn = await t.session.send("hi");
    expect(turn.reply).toBe("done");
    expect(t.posted).toHaveLength(2);
  });

  it("never leaks the api key, even when the endpoint echoes it", async () => {
    const t = await setup([
      toolMsg("c1", "lookup_order", `{"order_id":"${KEY}"}`),
      finalMsg(`your key is ${KEY}`),
    ]);
    const turn = await t.session.send("hi");
    expect(turn.reply).toContain("[redacted]");
    expect(JSON.stringify(turn)).not.toContain(KEY);
    const e = await setup([() => { throw new TargetError(`bad ${KEY}`); }]);
    expect(JSON.stringify(await e.session.send("hi"))).not.toContain(KEY);
  });
});
