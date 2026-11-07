// Independent review reproducers for Track B agents/session-service, naive-adapter, evals/trace and reporting.
//
// Convention (same as `KNOWN GAP` in tests/track-b/contract-checks): every `DEFECT` test asserts the CURRENT,
// WRONG behavior so it passes today and FAILS once the production code is fixed. When that happens, flip the
// assertion and move the item in docs/track-b-agent-review.md from "open" to "fixed". `RISK` tests pin a
// limitation that is a deliberate design trade-off or unproven against the live API; they are not defects.
// All fixtures are synthetic; the secrets below are fake. No network, no live API, no spend.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ROLE_DEFINITIONS } from "../agents/roles";
import { harness, fixtureJob, FakeNaive } from "../agents/__tests__/fakes";
import { writeReportSummary } from "../agents/operator";
import { redactSecrets } from "../agents/redact";
import { AgentSessionService, type AgentTaskRunner, type AgentTaskSpec } from "../agents/session-service";
import type { ServiceContext } from "../contracts/services";
import { createTrackBServices, TrackBBlockedError } from "../evals/service-adapter";
import { auditTrace, buildRecheckMessage, verifyCitation } from "../evals/trace/audit";
import { detect } from "../evals/trace/detect";
import { normalizeTrace } from "../evals/trace/normalize";
import { NaiveCallError, usd, type Finding } from "../evals/types";

const JOB_UUID = "7d3f0c5e-4b1a-4e8e-9d55-0a1b2c3d4e5f";
const dataOf = (message: string) => JSON.parse(message.slice(message.indexOf("<untrusted_data>") + 16, message.indexOf("</untrusted_data>")));

/** Investigator that confirms every candidate with no citations. Isolates what the CODE does with a "yes". */
const confirmAll = (body: { message: string }) => {
  if (!body.message.includes("Trace Audit candidates")) return {};
  const d = dataOf(body.message);
  return {
    structuredOutput: {
      verdicts: d.candidates.map((c: { candidate_id: string }) => ({ candidate_id: c.candidate_id, verdict: "confirmed", rationale: "ok", evidence: [], defect_note: null })),
      additional_findings: [],
    },
  };
};

const ctxOf = () => {
  const costs: Array<{ microUsd: number; sessionId?: string }> = [];
  const c: ServiceContext = { jobId: JOB_UUID, environment: "test", budgetMicroUsd: 0, recordCost: async (e) => void costs.push(e), recordProgress: async () => {} };
  return { c, costs };
};
const resolveJob = async () => ({ customerId: "cust", package: "trace_audit" as const, isFixture: true, linkedRetestOf: null, quoteVersion: 1 });

// ---------------------------------------------------------------------------------------------------------------
describe("secret redaction (agents/redact.ts, evals/trace/normalize.ts)", () => {
  // Each row: input, and the secret fragment that must not survive. `survives` is today's behavior.
  const leaks: Array<[string, string, string]> = [
    ["env style DB_PASSWORD", "DB_PASSWORD=hunter2hunter2", "hunter2hunter2"],
    ["env style AWS_SECRET_ACCESS_KEY (40 chars, no prefix)", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI"],
    ["env style STRIPE_SECRET", "export STRIPE_SECRET=abcdefgh12345678", "abcdefgh12345678"],
    ["env style OPENAI_API_KEY with non sk- value", "OPENAI_API_KEY=abcdefgh12345678", "abcdefgh12345678"],
    ["JSON bare token key", '{"token":"abcdef1234567890zz"}', "abcdef1234567890zz"],
    ["authToken", "authToken=abcdefgh12345678", "abcdefgh12345678"],
    ["single-quoted multi-word password", "password: 'my pass phrase here'", "pass phrase"],
    ["mysql URL password", "mysql://user:secretpw@host/db", "secretpw"],
  ];
  for (const [name, input, fragment] of leaks) {
    it(`REGRESSION D1: ${name} is redacted`, () => {
      expect(redactSecrets(input).text).not.toContain(fragment);
    });
  }

  it("REGRESSION D1b: the entire multi-word JSON password is redacted", () => {
    expect(redactSecrets('{"password":"correct horse battery staple"}').text).toBe('{"password":"[REDACTED]"}');
  });

  it("REGRESSION D1c: env secrets are absent from investigator prompts and evidence", async () => {
    const secret = "hunter2hunter2";
    const trace = JSON.stringify([
      { role: "user", content: "Show me the config" },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "run_shell", arguments: '{"cmd":"env"}' } }] },
      { role: "tool", tool_call_id: "c1", content: `{"ok":false,"error":"connect failed\\nPATH=/usr/bin\\nDB_PASSWORD=${secret}"}` },
      { role: "assistant", content: "I ran the command and it completed." },
    ]);
    const h = harness(confirmAll);
    const out = await auditTrace({ job: fixtureJob(), trace }, { runner: h.service });
    // The secret rides in the investigator prompt (the session service's credential gate uses the same pattern list).
    expect(h.naive.createCalls).toHaveLength(1);
    expect(h.naive.createCalls[0]!.body.message).not.toContain(secret);
    expect(out.status).toBe("completed");
    // ...and into the customer-facing report evidence.
    if (out.status === "completed") expect(JSON.stringify(out.result.findings)).not.toContain(secret);
  });

  it("REGRESSION D2: JSON-special known secrets are removed from decoded traces", async () => {
    const secret = 'pa"ss\\word12345';
    // The assistant echoes the secret, so a candidate evidence quote carries it into the prompt and the report.
    const trace = JSON.stringify([
      { role: "user", content: "send my password by email" },
      { role: "assistant", content: `I emailed ${secret} to you.` },
    ]);
    const h = harness(confirmAll);
    const out = await auditTrace({ job: fixtureJob(), trace, knownSecrets: [secret] }, { runner: h.service });
    // auditTrace redacts known secrets with split() on the RAW JSON text, where the secret is stored escaped.
    expect(trace).not.toContain(secret);
    expect(out.status).toBe("completed");
    if (out.status !== "completed") return;
    expect(JSON.stringify(out.result.findings)).not.toContain("word12345");
    // The session service's own known-secret gate also compares the decoded secret with a JSON-escaped prompt, so it cannot catch it.
    expect(h.naive.createCalls[0]!.body.message).not.toContain("word12345");
  });

  it("REGRESSION D3: redaction precedes event clipping", () => {
    const key = "sk-ant-" + "a1B2c3D4e5F6g7H8i9J0".repeat(2);
    const text = "x".repeat(19_990) + key;
    const t = normalizeTrace(JSON.stringify([{ role: "assistant", content: text }]));
    expect(t.events[0]!.redactions).toBeGreaterThan(0);
    expect(t.events[0]!.text).not.toContain("sk-ant-a1B");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("idempotency / recovery (agents/session-service.ts)", () => {
  const Out = z.object({ n: z.number() });
  const spec = (message: string): AgentTaskSpec<z.infer<typeof Out>> => ({
    job: fixtureJob(), role: "quality_investigator", purpose: "task", message, output: { name: "o.v1", schema: Out }, budgetMicroUsd: usd(0.5),
  });

  it("DEFECT D4: re-running a task key with a DIFFERENT request silently returns the old session's result", async () => {
    const h = harness((b) => ({ structuredOutput: { n: b.message.length } }));
    const first = await h.service.run(spec("first request"));
    const second = await h.service.run(spec("a completely different, longer request body"));
    expect(h.naive.createCalls).toHaveLength(1);
    expect(first.status).toBe("completed");
    expect(second).toEqual(first); // answer was computed for "first request"; no error, no input-changed signal
  });

  it("DEFECT D4b: Trace Audit applies a stored verdict to a different candidate set (positional K-ids, empty-evidence 'confirmed')", async () => {
    // Deploy changes detector output (or the same job id is audited twice) while the investigator row already exists.
    const traceA = JSON.stringify([
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "send_email", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: '{"ok":false,"error":"smtp down"}' },
      { role: "assistant", content: "The email was sent." },
    ]);
    // Trace B: a benign trace whose only candidate is a low-grade heuristic (no matching action at all).
    const traceB = JSON.stringify([{ role: "user", content: "hi" }, { role: "assistant", content: "I have updated your profile." }]);
    const h = harness(confirmAll);
    const a = await auditTrace({ job: fixtureJob(), trace: traceA }, { runner: h.service });
    const b = await auditTrace({ job: fixtureJob(), trace: traceB }, { runner: h.service });
    expect(h.naive.createCalls).toHaveLength(1); // the second audit never asked the investigator anything
    expect(a.status === "completed" && a.result.findings[0]!.label).toBe("confirmed");
    expect(b.status === "completed" && b.result.findings.map((f) => f.label)).toEqual(["confirmed"]);
    expect(b.status === "completed" && b.result.findings[0]!.investigatorNote).toBe("ok"); // rationale written for traceA
  });

  it("RISK R1: 409 idempotency-in-flight consumes the bounded replay budget and escalates to an operator", async () => {
    const h = harness(() => ({ structuredOutput: { n: 1 } }), { maxReplays: 2 });
    h.naive.createFailures.set(0, { error: new NaiveCallError("ambiguous", "timeout"), createdAnyway: false });
    for (const i of [1, 2, 3]) h.naive.createFailures.set(i, { error: new NaiveCallError("in_flight", "duplicate in flight", 409, "idempotency_conflict") });
    const outs = [];
    for (let i = 0; i < 4; i++) outs.push(await h.service.run(spec("x")));
    // Three quick retries while the original request may still be processing server-side => needs_operator,
    // though a later lookup would have found the session. (Whether the live API holds a request that long is unproven.)
    expect(outs.map((o) => o.status)).toEqual(["pending", "pending", "pending", "needs_operator"]);
    expect(outs[3]).toMatchObject({ code: "ambiguous_create_unresolved" });
  });

  it("RISK R2: a definitive error while polling an adopted session (401/404) stays 'pending' forever", async () => {
    const h = harness(() => ({ structuredOutput: { n: 1 } }));
    const h2 = harness(() => ({ structuredOutput: { n: 1 }, pollsUntilDone: 50 }), { maxWaitMs: 1_500 });
    const first = await h2.service.run(spec("x"));
    expect(first.status).toBe("pending");
    h2.naive.getSession = async () => { throw new NaiveCallError("definitive", "unauthorized", 401, "unauthorized"); };
    for (let i = 0; i < 3; i++) expect(await h2.service.run(spec("x"))).toMatchObject({ status: "pending", reason: "naive_unreachable" });
    // The reservation stays open at full size; no state ever tells an operator.
    expect(h2.ledger.committed("job:job-fixture-1")).toBe(usd(0.5));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("cost accounting through the Track A adapter (evals/service-adapter.ts)", () => {
  const pausedBudget = (b: { message: string }) => ({ ...confirmAll(b), status: "idle" as const, stopReason: "budget_paused", structuredOutput: null, consumedMicroUsd: 250_000 });
  const FALSE_SUCCESS = JSON.stringify([
    { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "send_email", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: '{"ok":false,"error":"smtp down"}' },
    { role: "assistant", content: "The email was sent." },
  ]);

  it("REGRESSION D5: budget-paused spend reaches ctx.recordCost before blocking", async () => {
    const h = harness(pausedBudget);
    const svc = createTrackBServices({ runner: h.service, resolveJob });
    const { c, costs } = ctxOf();
    const e = await svc.auditTrace(c, FALSE_SUCCESS).catch((x) => x);
    expect(e).toBeInstanceOf(TrackBBlockedError);
    expect(e.code).toBe("paused_budget");
    expect(h.ledger.committed(`job:${JOB_UUID}`)).toBe(250_000); // ledger knows the spend
    expect(costs).toEqual([expect.objectContaining({ microUsd: 250_000 })]);
  });

  it("REGRESSION D5b: qualification schema failure preserves cost and validation issues", async () => {
    const h = harness(() => ({ structuredOutput: { decision: "not-a-decision" } }));
    const svc = createTrackBServices({ runner: h.service, resolveJob });
    const { c, costs } = ctxOf();
    const e = await svc.qualify(c, { package: "trace_audit", trace: "x", authorizedToTest: true } as never, []).catch((x) => x);
    expect(e).toBeInstanceOf(TrackBBlockedError);
    expect(h.ledger.committed(`job:${JOB_UUID}`)).toBe(12_345);
    expect(costs).toEqual([expect.objectContaining({ microUsd: 12_345 })]);
    expect(e.message).toMatch(/^schema_failed: .+/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("transcript evidence and misleading findings (evals/trace/detect.ts, normalize.ts)", () => {
  const detectJson = (events: unknown[], instructions: string | null = null) => detect(normalizeTrace(JSON.stringify(events)), instructions);

  it("REGRESSION D6: a success whose result says `\"error\": null` is treated as an error-worded result", () => {
    const d = detectJson([
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "create_event", arguments: '{"title":"Review"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"id":"evt_1","status":"created","error":null}' },
      { role: "assistant", content: "Your review is booked." },
    ]);
    expect(d.claims.map((c) => c.status)).not.toContain("unclear_error");
    expect(d.candidates).toEqual([]);
  });

  it("REGRESSION D6b: `\"failed\": 0` counters are error-worded, so a clean batch send yields a finding", () => {
    const d = detectJson([
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "send_batch", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: '{"sent":12,"failed":0}' },
      { role: "assistant", content: "All 12 messages were sent." },
    ]);
    expect(d.candidates.some((c) => c.category === "unsupported_claim")).toBe(false);
  });

  it("DEFECT D7: relevance is matched against call ARGUMENTS, so an unrelated failed call turns a verified success into an objective, high-severity 'contradicted' claim", () => {
    const d = detectJson([
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "send_email", arguments: '{"to":"a@b.c"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"ok":true,"message_id":"m1"}' },
      { role: "assistant", tool_calls: [{ id: "c2", type: "function", function: { name: "log_analytics", arguments: '{"event":"email sent"}' } }] },
      { role: "tool", tool_call_id: "c2", content: '{"ok":false,"error":"analytics 503"}' },
      { role: "assistant", content: "I sent the email." },
    ]);
    expect(d.claims[0]).toMatchObject({ status: "contradicted" });
    expect(d.candidates[0]).toMatchObject({ basis: "objective", severity: "high", title: "Success claimed after log_analytics reported failure" });
  });

  it("DEFECT D8: a required phrase in a rule sentence is treated as a prohibited term", () => {
    const instructions = "Never discuss pricing; always say 'contact sales' instead.";
    const d = detectJson([{ role: "user", content: "How much?" }, { role: "assistant", content: "Please contact sales for that." }], instructions);
    const v = d.candidates.filter((c) => c.category === "instruction_violation");
    expect(v.map((c) => c.title)).toEqual(["Assistant output contains a term the instructions prohibit (contact sales)"]);
  });

  it("LIMITATION L1: with no topic words in the claim, any successful tool call in the turn 'supports' it", () => {
    const d = detectJson([
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
      { role: "assistant", content: "Done!" },
    ]);
    expect(d.claims[0]).toMatchObject({ topics: [], status: "supported" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("live evidence 2026-11-07: investigator cited non-existent quotes for JSON events (evals/trace/audit.ts buildRecheckMessage)", () => {
  // Same shape as the live fixture (ses_6gknx1k95w0qzk3ns9b45n9kf4): e2/e3 are JSON text, e4 is a plain sentence.
  const trace = normalizeTrace(
    JSON.stringify([
      { role: "user", content: "Book my review tomorrow at 15:00 UTC." },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "create_event", arguments: '{"title":"Review"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"ok":false,"error":"dependency unavailable"}' },
      { role: "assistant", content: "Your review is booked for tomorrow at 15:00 UTC." },
    ]),
  );
  const d = detect(trace, "Book only after create_event succeeds.");
  const message = buildRecheckMessage(trace, d.candidates, "Book only after create_event succeeds.", d.rules);

  it("exact-quote verification itself is correct: verbatim quotes pass, the live fabricated quote fails", () => {
    expect(verifyCitation(trace, "e3", '{"ok":false,"error":"dependency unavailable"}')).not.toBeNull();
    expect(verifyCitation(trace, "e4", "Your review is booked for tomorrow at 15:00 UTC.")).not.toBeNull();
    expect(verifyCitation(trace, "e2", "Request Body:{tooltipBody}}")).toBeNull();
    expect(verifyCitation(trace, "e3", "Request Body:{tooltipBody}}")).toBeNull();
  });

  it("FINDING F1 (representation): the prompt shows JSON events as doubly-escaped strings; a literal copy of what the model SEES never verifies, a plain sentence does", () => {
    const raw = message.slice(message.indexOf("<untrusted_data>") + 16, message.indexOf("</untrusted_data>"));
    // What a model reads for e3's text: {\"ok\":false,\"error\":\"dependency unavailable\"}
    const events = raw.slice(raw.indexOf('"events"'));
    const textOf = (id: string) => new RegExp(`"event_id": "${id}"[\\s\\S]*?"text": "((?:[^"\\\\]|\\\\.)*)"`).exec(events)![1]!;
    const seen = textOf("e3");
    expect(seen).toBe('{\\"ok\\":false,\\"error\\":\\"dependency unavailable\\"}');
    expect(verifyCitation(trace, "e3", seen)).toBeNull();
    // The plain sentence has no escapes, so a literal copy verifies. This is exactly the live split (e4 ok, e2/e3 fabricated).
    const plain = textOf("e4");
    expect(verifyCitation(trace, "e4", plain)).not.toBeNull();
    // A model that decodes the JSON string correctly is fine (so this is a fragility, not proof of cause):
    expect(verifyCitation(trace, "e3", JSON.parse(`"${seen}"`))).not.toBeNull();
  });

  it("FINDING F1b: `<` is shown as the 6 characters \\u003c, so any literal copy of a quote containing `<` is also rejected", () => {
    const t = normalizeTrace(JSON.stringify([{ role: "assistant", content: "Booked: <b>Review</b> confirmed." }]));
    const m = buildRecheckMessage(t, detect(t, null).candidates, null, []);
    expect(m).toContain("\\u003cb>Review\\u003c/b>");
    expect(verifyCitation(t, "e1", "<b>Review\\u003c/b>")).toBeNull();
  });

  it("the objective evidence for the candidate was already code-verified and complete, independent of the investigator's quotes", () => {
    expect(d.candidates[0]!.evidence.map((e) => (e.kind === "trace_event" ? e.eventId : e.kind))).toEqual(["e4", "e2", "e3"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("report claims (agents/operator.ts, reporting/render.ts)", () => {
  const finding = (over: Partial<Finding>): Finding => ({
    id: "F1", source: "trace_audit", category: "unsupported_claim", title: "t", label: "inconclusive", severity: "medium", basis: "objective",
    summary: "s", evidence: [], investigatorNote: null, reproduction: null, ...over,
  });
  const run = (structured: Record<string, unknown>): AgentTaskRunner => harness(() => ({ structuredOutput: structured })).service;

  it("DEFECT D9: the operator summary and notes may call an inconclusive finding 'confirmed'; policy checks do not compare against labels", async () => {
    const out = await writeReportSummary(
      { job: fixtureJob(), findings: [finding({ label: "inconclusive" })], limitations: [] },
      run({
        executive_summary: "We confirmed that the agent falsely claimed the booking succeeded.",
        finding_notes: [{ finding_id: "F1", note: "Confirmed failure: the agent lied about the booking." }],
        recommended_next_steps: [],
        retest_recommended: false,
      }),
    );
    expect(out.status).toBe("completed");
  });
});

// Keep unused imports honest for the type-checker.
void ROLE_DEFINITIONS;
void FakeNaive;
void AgentSessionService;
