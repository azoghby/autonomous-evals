// FIXTURE tests: engine logic against a fake Naïve API. Not live SDK validation.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NaiveCallError, usd } from "../../evals/types";
import { AgentSessionService, type AgentTaskSpec } from "../session-service";
import { fixtureJob, harness } from "./fakes";

const Out = z.object({ answer: z.string(), score: z.number().int() });
const spec = (over: Partial<AgentTaskSpec<z.infer<typeof Out>>> = {}): AgentTaskSpec<z.infer<typeof Out>> => ({
  job: fixtureJob(),
  role: "quality_investigator",
  purpose: "unit_task",
  message: "Return a JSON answer.",
  output: { name: "unit.v1", schema: Out },
  budgetMicroUsd: usd(0.5),
  ...over,
});
const good = () => ({ structuredOutput: { answer: "ok", score: 3 } });

describe("AgentSessionService: happy path and persistence", () => {
  it("reserves, persists intent, creates with a deterministic key, validates output, settles usage", async () => {
    const h = harness(good);
    const out = await h.service.run(spec());
    expect(out.status).toBe("completed");
    if (out.status !== "completed") return;
    expect(out.output).toEqual({ answer: "ok", score: 3 });
    expect(out.cost).toMatchObject({ source: "naive_session", role: "quality_investigator", microUsd: 12_345, measured: true });

    expect(h.naive.createCalls).toHaveLength(1);
    const call = h.naive.createCalls[0]!;
    expect(call.key).toMatch(/^ae-test-[0-9a-f]{48}$/);
    expect(call.body.structured_output_required).toBe(true);
    expect(call.body.budget_micro_usd).toBe(usd(0.5));
    expect(call.body.output_schema).toMatchObject({ type: "object", required: ["answer", "score"] });
    expect(call.body.metadata.ae_task_key).toBe("job-fixture-1:quality_investigator:unit_task:1");

    const row = await h.store.get(out.taskKey);
    expect(row).toMatchObject({ state: "completed", sessionId: out.session.sessionId, consumedMicroUsd: 12_345 });
    // Reservation replaced by measured spend.
    expect(h.ledger.committed("job:job-fixture-1")).toBe(12_345);
  });

  it("re-running a completed task returns the stored result without a new session", async () => {
    const h = harness(good);
    const a = await h.service.run(spec());
    const b = await h.service.run(spec());
    expect(b).toEqual(a);
    expect(h.naive.createCalls).toHaveLength(1);
  });

  it("returns pending while the session runs, then resumes the same session (restart-safe)", async () => {
    const h = harness(() => ({ ...good(), pollsUntilDone: 5 }), { maxWaitMs: 2_000 });
    const first = await h.service.run(spec());
    expect(first).toMatchObject({ status: "pending", reason: "session_running" });
    // A fresh service instance (new process after redeploy) with the same durable store.
    const restarted = new AgentSessionService({ ...h.deps, workerId: "worker-b", maxWaitMs: 60_000 });
    const second = await restarted.run(spec());
    expect(second.status).toBe("completed");
    expect(h.naive.createCalls).toHaveLength(1);
  });

  it("refuses a prompt containing a credential before reserving or sending", async () => {
    const h = harness(good);
    const out = await h.service.run(spec({ message: "use key sk-proj-abcdefghijklmnopqrstuvwx1234" }));
    expect(out).toMatchObject({ status: "failed", code: "credential_in_prompt" });
    const known = await h.service.run(spec({ purpose: "unit_task2", message: "customer key is zz-custom-secret-1", knownSecrets: ["zz-custom-secret-1"] }));
    expect(known).toMatchObject({ status: "failed", code: "credential_in_prompt" });
    expect(h.naive.createCalls).toHaveLength(0);
    expect(h.ledger.reservations.size).toBe(0);
  });
});

describe("AgentSessionService: malformed and non-success results", () => {
  it("schema mismatch is schema_failed, settled, and not retried", async () => {
    const h = harness(() => ({ structuredOutput: { answer: 42 } }));
    const out = await h.service.run(spec());
    expect(out.status).toBe("schema_failed");
    if (out.status === "schema_failed") expect(out.issues.join(" ")).toMatch(/answer/);
    expect((await h.service.run(spec())).status).toBe("schema_failed");
    expect(h.naive.createCalls).toHaveLength(1);
    expect(h.ledger.committed("job:job-fixture-1")).toBe(12_345);
  });

  it("an idle session with no document is not a success", async () => {
    const h = harness(() => ({ structuredOutput: null }));
    expect((await h.service.run(spec())).status).toBe("schema_failed");
    const h2 = harness(() => ({ stopReason: "error", stopCode: null }));
    expect(await h2.service.run(spec())).toMatchObject({ status: "schema_failed", issues: ["structured output required but not produced"] });
  });

  it("model errors, budget pauses and questions map to distinct outcomes", async () => {
    expect(await harness(() => ({ stopReason: "error", stopCode: "rate_limited" })).service.run(spec())).toMatchObject({ status: "failed", code: "rate_limited" });
    expect((await harness(() => ({ stopReason: "budget_paused" })).service.run(spec())).status).toBe("budget_paused");
    expect(await harness(() => ({ stopReason: "awaiting_input" })).service.run(spec())).toMatchObject({ status: "needs_operator", code: "agent_requested_input" });
    expect(await harness(() => ({ status: "failed", stopReason: null, stopCode: "internal_error" })).service.run(spec())).toMatchObject({ status: "failed", code: "internal_error" });
  });

  it("a definitive API rejection fails the task and releases the reservation", async () => {
    const h = harness(good);
    h.naive.createFailures.set(0, { error: new NaiveCallError("definitive", "bad", 400, "validation_failed") });
    expect(await h.service.run(spec())).toMatchObject({ status: "failed", code: "validation_failed" });
    expect(h.ledger.committed("job:job-fixture-1")).toBe(0);
  });
});

describe("AgentSessionService: budgets", () => {
  it("refuses a task once the job cap would be exceeded, with no session and no hidden retry", async () => {
    const h = harness(() => ({ ...good(), consumedMicroUsd: usd(1.5) }));
    const job = fixtureJob(); // trace_audit: $3 job cap
    const a = await h.service.run(spec({ job, purpose: "t1", budgetMicroUsd: usd(1.5) }));
    const b = await h.service.run(spec({ job, purpose: "t2", budgetMicroUsd: usd(1.5) }));
    const c = await h.service.run(spec({ job, purpose: "t3", budgetMicroUsd: usd(1.5) }));
    expect([a.status, b.status]).toEqual(["completed", "completed"]);
    expect(c).toMatchObject({ status: "budget_exhausted", exhaustedScope: "job:job-fixture-1", availableMicroUsd: 0 });
    expect(h.naive.createCalls).toHaveLength(2);
  });

  it("concurrent reservations never exceed the cap", async () => {
    const h = harness(good);
    const job = fixtureJob();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => h.service.run(spec({ job, purpose: `race_${i}`, budgetMicroUsd: usd(0.7) }))),
    );
    const reserved = results.filter((r) => r.status !== "budget_exhausted");
    expect(reserved).toHaveLength(4); // floor(3.0 / 0.7)
    expect(h.naive.createCalls).toHaveLength(4);
    expect(results.filter((r) => r.status === "budget_exhausted")).toHaveLength(16);
  });

  it("enforces the role period cap across jobs", async () => {
    const h = harness(() => ({ ...good(), consumedMicroUsd: usd(1) }));
    h.ledger.caps.set("agent:company_operator:2026-11-hackathon", usd(2));
    const run = (j: string) =>
      h.service.run(spec({ job: fixtureJob({ jobId: j }), role: "company_operator", purpose: "summary", budgetMicroUsd: usd(1) }));
    expect((await run("j1")).status).toBe("completed");
    expect((await run("j2")).status).toBe("completed");
    expect(await run("j3")).toMatchObject({ status: "budget_exhausted", exhaustedScope: "agent:company_operator:2026-11-hackathon" });
  });

  it("rejects a task budget above the role's per-session maximum", async () => {
    const h = harness(good);
    expect(await h.service.run(spec({ budgetMicroUsd: usd(50) }))).toMatchObject({ status: "failed", code: "invalid_task_budget" });
  });
});

describe("AgentSessionService: ambiguous creation and recovery", () => {
  it.each([401, 403, 404])("escalates inaccessible saved sessions (%s) without recreating or releasing unknown spend", async (status) => {
    const h = harness(good);
    let polls = 0;
    h.naive.getSession = async () => {
      polls++;
      throw new NaiveCallError("definitive", "provider detail must stay private", status);
    };
    const out = await h.service.run(spec());
    expect(out).toMatchObject({ status: "needs_operator", code: "session_unavailable", sessionIds: ["ses_fake_1"] });
    expect(JSON.stringify(out)).not.toContain("provider detail");
    const reservation = structuredClone([...h.ledger.reservations.values()]);
    expect(h.ledger.committed("job:job-fixture-1")).toBe(usd(0.5));
    const restarted = new AgentSessionService({ ...h.deps, workerId: "restart" });
    expect(await restarted.run(spec())).toMatchObject({ status: "needs_operator", code: "session_unavailable" });
    expect([...h.ledger.reservations.values()]).toEqual(reservation);
    expect(h.naive.createCalls).toHaveLength(1);
    expect(polls).toBe(1);
  });

  it("keeps transient polling failures resumable on the same saved session", async () => {
    const h = harness(good);
    const original = h.naive.getSession.bind(h.naive);
    h.naive.getSession = async () => { throw new NaiveCallError("ambiguous", "temporary", 503); };
    expect(await h.service.run(spec())).toMatchObject({ status: "pending", sessionId: "ses_fake_1" });
    h.naive.getSession = original;
    expect(await new AgentSessionService({ ...h.deps, workerId: "restart" }).run(spec())).toMatchObject({ status: "completed" });
    expect(h.naive.createCalls).toHaveLength(1);
  });

  it("a timeout after the server created the session is recovered by lookup, never re-created", async () => {
    const h = harness(good);
    h.naive.createFailures.set(0, { error: new NaiveCallError("ambiguous", "timeout"), createdAnyway: true });
    const first = await h.service.run(spec());
    expect(first).toMatchObject({ status: "pending", reason: "recovering" });
    expect((await h.store.get(first.taskKey))?.state).toBe("ambiguous");
    const second = await h.service.run(spec());
    expect(second.status).toBe("completed");
    expect(h.naive.createCalls).toHaveLength(1);
    expect(h.naive.sessions.size).toBe(1);
  });

  it("when lookup finds nothing, replays only the stored body with the stored key, then escalates", async () => {
    const h = harness(good, { maxReplays: 2 });
    for (let i = 0; i < 3; i++) h.naive.createFailures.set(i, { error: new NaiveCallError("ambiguous", "502 from proxy", 502) });
    const outs = [];
    for (let i = 0; i < 4; i++) outs.push(await h.service.run(spec()));
    expect(outs.map((o) => o.status)).toEqual(["pending", "pending", "pending", "needs_operator"]);
    expect(outs[3]).toMatchObject({ code: "ambiguous_create_unresolved" });
    const keys = new Set(h.naive.createCalls.map((c) => c.key));
    const bodies = new Set(h.naive.createCalls.map((c) => JSON.stringify(c.body)));
    expect(h.naive.createCalls).toHaveLength(3); // original + 2 bounded replays
    expect(keys.size).toBe(1);
    expect(bodies.size).toBe(1);
    // Escalated tasks stay escalated: no further create.
    expect((await h.service.run(spec())).status).toBe("needs_operator");
    expect(h.naive.createCalls).toHaveLength(3);
  });

  it("a crash between intent and create (expired lease) goes through lookup first", async () => {
    const h = harness(good);
    // Simulate a worker that persisted intent, sent create, then died before saving the ID.
    h.naive.createFailures.set(0, { error: new NaiveCallError("ambiguous", "process killed"), createdAnyway: true });
    await h.service.run(spec());
    const row = (await h.store.get("job-fixture-1:quality_investigator:unit_task:1"))!;
    await h.store.compareAndSet(row.taskKey, row.revision, { state: "creating", leaseOwner: "dead-worker", leaseExpiresAt: new Date(h.clock.t + 60_000).toISOString() });

    const other = new AgentSessionService({ ...h.deps, workerId: "worker-b" });
    expect(await other.run(spec())).toMatchObject({ status: "pending", reason: "create_in_progress_elsewhere" });
    h.clock.advance(61_000);
    expect((await other.run(spec())).status).toBe("completed");
    expect(h.naive.sessions.size).toBe(1);
  });

  it("rate limiting retries later with the same key and does not use up replays", async () => {
    const h = harness(good, { maxReplays: 0 });
    h.naive.createFailures.set(0, { error: new NaiveCallError("rate_limited", "429", 429, "rate_limited") });
    expect(await h.service.run(spec())).toMatchObject({ status: "pending", reason: "rate_limited" });
    expect((await h.service.run(spec())).status).toBe("completed");
    expect(new Set(h.naive.createCalls.map((c) => c.key)).size).toBe(1);
  });

  it("an unreachable API during recovery stays pending (no create)", async () => {
    const h = harness(good);
    h.naive.createFailures.set(0, { error: new NaiveCallError("ambiguous", "timeout") });
    await h.service.run(spec());
    h.naive.listFailure = new NaiveCallError("ambiguous", "down");
    expect(await h.service.run(spec())).toMatchObject({ status: "pending", reason: "naive_unreachable" });
    expect(h.naive.createCalls).toHaveLength(1);
  });

  it("duplicate sessions for one task are escalated, not silently picked", async () => {
    const h = harness(good);
    h.naive.createFailures.set(0, { error: new NaiveCallError("ambiguous", "timeout"), createdAnyway: true });
    await h.service.run(spec());
    h.naive.injectDuplicate(h.naive.createCalls[0]!.body);
    const out = await h.service.run(spec());
    expect(out).toMatchObject({ status: "needs_operator", code: "duplicate_sessions" });
    if (out.status === "needs_operator") expect(out.sessionIds).toHaveLength(2);
  });

  it("two workers racing on the same task create one session", async () => {
    const h = harness(() => ({ ...good(), pollsUntilDone: 1 }));
    const b = new AgentSessionService({ ...h.deps, workerId: "worker-b" });
    const [x, y] = await Promise.all([h.service.run(spec()), b.run(spec())]);
    expect([x.status, y.status]).toContain("completed");
    expect(h.naive.createCalls).toHaveLength(1);
    expect(h.ledger.reservations.size).toBe(1);
  });
});


describe("AgentSessionService: dispatch screening and cached version evidence", () => {
  it("screens the actual stored create message after intent persistence", async () => {
    const h = harness(good);
    const insert = h.store.insertIfAbsent.bind(h.store);
    h.store.insertIfAbsent = async record => insert({
      ...record,
      requestBody: { ...record.requestBody, message: "stored opaque dispatch marker" },
    });
    const out = await h.service.run(spec({ knownSecrets: ["opaque dispatch marker"] }));
    expect(out).toMatchObject({ status: "needs_operator", code: "credential_in_prompt" });
    expect(h.naive.createCalls).toHaveLength(0);
    expect([...h.ledger.reservations.values()]).toMatchObject([{ settledMicroUsd: null }]);
    expect(h.ledger.committed("job:job-fixture-1")).toBe(usd(0.5));
  });

  it("applies a current secret learned while intent persistence awaited", async () => {
    const h = harness(good);
    const knownSecrets: string[] = [];
    const insert = h.store.insertIfAbsent.bind(h.store);
    h.store.insertIfAbsent = async record => {
      const saved = await insert(record);
      knownSecrets.push("newly sensitive marker");
      return saved;
    };
    expect(await h.service.run(spec({ message: "Evidence newly sensitive marker", knownSecrets })))
      .toMatchObject({ status: "needs_operator", code: "credential_in_prompt" });
    expect(h.naive.createCalls).toHaveLength(0);
    expect([...h.ledger.reservations.values()]).toMatchObject([{ settledMicroUsd: null }]);
  });

  it("refuses a cached historical output with a mismatched observed pin and retains cost", async () => {
    const h = harness(good);
    const directory = structuredClone(h.deps.directory);
    directory.quality_investigator.agentVersion = 1;
    const service = new AgentSessionService({ ...h.deps, directory });
    const first = await service.run(spec());
    expect(first.status).toBe("completed");
    const row = (await h.store.get(first.taskKey))!;
    await h.store.compareAndSet(row.taskKey, row.revision, { agentVersion: 2 });
    const calls = h.naive.getCalls;
    const out = await service.run(spec());
    expect(out).toMatchObject({ status: "needs_operator", code: "agent_version_mismatch", cost: { microUsd: 12_345, measured: true } });
    expect(h.naive.getCalls).toBe(calls);
    expect(h.naive.createCalls).toHaveLength(1);
    expect(h.ledger.committed("job:job-fixture-1")).toBe(12_345);
  });
});
