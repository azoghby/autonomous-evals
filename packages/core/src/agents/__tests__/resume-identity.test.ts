// FIXTURE tests only: no live provider calls. Reusing a task key must never reuse another request's answer.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NaiveCallError, usd } from "../../evals/types";
import { AgentSessionService, type AgentTaskSpec } from "../session-service";
import { directory, fixtureJob, harness } from "./fakes";

const Out = z.object({ answer: z.string(), score: z.number().int() });
type Output = z.infer<typeof Out>;
const spec = (over: Partial<AgentTaskSpec<Output>> = {}): AgentTaskSpec<Output> => ({
  job: fixtureJob(), role: "quality_investigator", purpose: "resume_identity",
  message: "Investigate the first trace.", output: { name: "identity.v1", schema: Out },
  budgetMicroUsd: usd(0.5), ...over,
});
const good = () => ({ structuredOutput: { answer: "first trace evidence", score: 3 } });
type Harness = ReturnType<typeof harness>;
const snapshot = (h: Harness) => structuredClone({
  rows: [...h.store.rows], reservations: [...h.ledger.reservations], caps: [...h.ledger.caps],
  sessions: [...h.naive.sessions], creates: h.naive.createCalls, gets: h.naive.getCalls,
});

async function expectUnchangedMismatch(h: Harness, changed: AgentTaskSpec<Output>, service = new AgentSessionService({ ...h.deps, workerId: "restarted-worker" })) {
  const before = snapshot(h);
  const create = vi.spyOn(h.naive, "createSession");
  const get = vi.spyOn(h.naive, "getSession");
  const list = vi.spyOn(h.naive, "listAgentSessions");
  const reserve = vi.spyOn(h.ledger, "reserve");
  const settle = vi.spyOn(h.ledger, "settle");
  const cas = vi.spyOn(h.store, "compareAndSet");
  const insert = vi.spyOn(h.store, "insertIfAbsent");
  const outcome = await service.run(changed);
  expect(outcome).toMatchObject({ status: "needs_operator", code: "task_input_changed" });
  expect(outcome).not.toHaveProperty("output");
  for (const spy of [create, get, list, reserve, settle, cas, insert]) expect(spy).not.toHaveBeenCalled();
  // Preserve the first session's result/cost/error/request, active lease and open/settled reservations verbatim.
  expect(snapshot(h)).toEqual(before);
  for (const spy of [create, get, list, reserve, settle, cas, insert]) spy.mockRestore();
  return outcome;
}

describe("D4: durable request identity before returning stored output", () => {
  const changes: Array<[string, () => AgentTaskSpec<Output>]> = [
    ["message", () => spec({ message: "Investigate a different trace with the same positional finding ids." })],
    ["output name", () => spec({ output: { name: "identity.v2", schema: Out } })],
    ["schema with the same name", () => spec({ output: { name: "identity.v1", schema: z.object({ answer: z.string().min(2), score: z.number().int() }) } })],
    ["session budget", () => spec({ budgetMicroUsd: usd(0.6) })],
    ["job environment", () => spec({ job: fixtureJob({ environment: "live" }) })],
    ["job package", () => spec({ job: fixtureJob({ package: "text_eval" }) })],
    ["job cap", () => spec({ jobCapMicroUsd: usd(2) })],
    ["fixture identity", () => spec({ job: fixtureJob({ isFixture: false }) })],
  ];
  for (const [name, changed] of changes) it(`rejects changed ${name} without replacing stored evidence or spending`, async () => {
    const h = harness(good);
    expect((await h.service.run(spec())).status).toBe("completed");
    await expectUnchangedMismatch(h, changed());
    // Mismatch is local to the caller, so the original request remains recoverable.
    const original = await h.service.run(spec());
    expect(original).toMatchObject({ status: "completed", output: { answer: "first trace evidence", score: 3 } });
    expect(h.naive.createCalls).toHaveLength(1);
  });

  for (const [name, agent] of [
    ["agent id", { agentId: "agt_redeployed_investigator" }],
    ["pinned agent version", { ...directory.quality_investigator, agentVersion: 2 }],
  ] as const) it(`rejects changed directory ${name} before returning a completed result`, async () => {
    const h = harness(good);
    await h.service.run(spec());
    const restarted = new AgentSessionService({ ...h.deps, directory: { ...directory, quality_investigator: agent } });
    await expectUnchangedMismatch(h, spec(), restarted);
  });

  it("accepts separately constructed equivalent schemas, including property/required ordering", async () => {
    const h = harness(good);
    const first = await h.service.run(spec());
    const schema = z.object({ score: z.number().int(), answer: z.string() });
    const restarted = new AgentSessionService({ ...h.deps, workerId: "worker-b" });
    expect(await restarted.run(spec({ output: { name: "identity.v1", schema } }))).toEqual(first);
    expect(h.naive.createCalls).toHaveLength(1);
  });

  it("compares pre-upgrade durable request bodies without requiring new metadata fields", async () => {
    const h = harness(good);
    const first = await h.service.run(spec());
    const row = h.store.rows.get(first.taskKey)!;
    const oldKeys = new Set(["ae_task_key", "ae_job_id", "ae_role", "ae_purpose", "ae_output", "ae_environment", "ae_fixture"]);
    for (const key of Object.keys(row.requestBody.metadata)) if (!oldKeys.has(key)) delete row.requestBody.metadata[key];
    expect(await new AgentSessionService(h.deps).run(spec())).toEqual(first);
    await expectUnchangedMismatch(h, spec({ message: "changed after upgrade" }));
  });

  it("an explicit new attempt creates a fresh request rather than reusing old evidence", async () => {
    const h = harness(good);
    const first = await h.service.run(spec());
    const second = await h.service.run(spec({ attempt: 2, message: "Investigate a new trace." }));
    expect(second.status).toBe("completed");
    expect(second.taskKey).not.toBe(first.taskKey);
    expect(h.naive.createCalls).toHaveLength(2);
  });
});

describe("D4: guard every resume/recovery path before polling, leases or replay", () => {
  it("does not poll an already adopted running session for a different request", async () => {
    const h = harness(() => ({ ...good(), pollsUntilDone: 20 }), { maxWaitMs: 1_000 });
    expect(await h.service.run(spec())).toMatchObject({ status: "pending", reason: "session_running" });
    await expectUnchangedMismatch(h, spec({ message: "new trace while previous session is running" }));
  });

  for (const createdAnyway of [false, true]) it(`does not scan, adopt or replay an ambiguous create (server created=${createdAnyway})`, async () => {
    const h = harness(good);
    h.naive.createFailures.set(0, { error: new NaiveCallError("ambiguous", "response lost"), createdAnyway });
    expect(await h.service.run(spec())).toMatchObject({ status: "pending", reason: "recovering" });
    await expectUnchangedMismatch(h, spec({ message: "new trace after create timeout" }));
    expect((await h.service.run(spec())).status).toBe("completed");
  });

  for (const expired of [false, true]) it(`leaves a creating worker lease intact (expired=${expired}) on mismatch`, async () => {
    const h = harness(good);
    h.naive.createFailures.set(0, { error: new NaiveCallError("ambiguous", "worker crashed"), createdAnyway: true });
    const first = await h.service.run(spec());
    const row = (await h.store.get(first.taskKey))!;
    await h.store.compareAndSet(row.taskKey, row.revision, {
      state: "creating", leaseOwner: "crashed-worker",
      leaseExpiresAt: new Date(h.clock.t + (expired ? -1 : 60_000)).toISOString(),
    });
    await expectUnchangedMismatch(h, spec({ message: "new trace after a deploy" }));
  });

  it("does not replay a rate limited create with a different schema", async () => {
    const h = harness(good);
    h.naive.createFailures.set(0, { error: new NaiveCallError("rate_limited", "429", 429, "rate_limited") });
    expect(await h.service.run(spec())).toMatchObject({ status: "pending", reason: "rate_limited" });
    await expectUnchangedMismatch(h, spec({ output: { name: "identity.v2", schema: Out } }));
  });

  it("checks the winner's durable body after losing the insert race", async () => {
    const h = harness(good);
    const first = await h.service.run(spec());
    const stored = (await h.store.get(first.taskKey))!;
    const before = snapshot(h);
    // Simulate a worker's initial miss followed by another worker winning insertIfAbsent.
    vi.spyOn(h.store, "get").mockResolvedValueOnce(null);
    const insert = vi.spyOn(h.store, "insertIfAbsent").mockResolvedValueOnce({ inserted: false, record: stored });
    const get = vi.spyOn(h.naive, "getSession");
    const list = vi.spyOn(h.naive, "listAgentSessions");
    expect(await h.service.run(spec({ message: "losing worker's different request" }))).toMatchObject({ status: "needs_operator", code: "task_input_changed" });
    expect(insert).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(snapshot(h)).toEqual(before);
  });
});
