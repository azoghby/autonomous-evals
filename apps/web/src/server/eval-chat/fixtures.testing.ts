/** Typed factories for eval-copilot tests: a 3-scenario sandbox run report and a 2-finding audit job. No I/O. */
import { vi } from "vitest";
import { SandboxScenario, type CheckResult, type EvalVersions, type ScenarioResult, type StateDiff, type TrialResult } from "@ae/core/sandbox/spec";
import type { SandboxRunReport } from "@/components/sandbox/contract";
import type { RunTarget } from "@/server/sandbox/engine-service";
import type { ActionDeps, JobContext, SandboxContext } from "./actions";
import type { JobGroundingInput } from "./job-grounding";
import { createMemoryEvalChatStore } from "./store";

export const OWNER = "00000000-0000-4000-8000-0000000000a1";
export const OTHER_OWNER = "00000000-0000-4000-8000-0000000000b2";
export const RUN_ID = "run_11111111-1111-4111-8111-111111111111";
export const OTHER_RUN_ID = "run_22222222-2222-4222-8222-222222222222";
export const JOB_ID = "33333333-3333-4333-8333-333333333333";

export const SC_PASS = "sx_refund_ok";
export const SC_FLAKY = "sx_refund_flaky";
export const SC_POLICY = "sx_refund_old";

/** Distinctive strings so tests can assert on presence/absence. */
export const TRANSCRIPT_MARKER = "ZEBRA-TRANSCRIPT-MARKER";
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const FAKE_SECRET = `sk-ant-api03-${Array.from({ length: 40 }, (_, i) => ALPHABET[(i * 7 + 3) % ALPHABET.length]).join("")}`;

const versions: EvalVersions = { spec: "sandbox-spec-v1", suiteHash: "s", simulatorModel: "sim", judgeModel: "judge", envHash: "e", runtime: "rt" };

const scenario = (id: string, title: string, category: SandboxScenario["category"]) =>
  SandboxScenario.parse({
    id, workflowId: "refund_request", title, category,
    persona: { name: "Ann", goal: "Get a refund", knowledge: [], style: "polite" },
  });

export const check = (over: Partial<CheckResult> = {}): CheckResult => ({ id: "c1", kind: "state", passed: true, severity: "high", detail: "ok", ...over });

export const trial = (scenarioId: string, n: number, over: Partial<TrialResult> = {}): TrialResult => ({
  scenarioId, trial: n, variant: "base", versions, passed: true, checks: [check()],
  transcript: [{ role: "user", content: "Hi, refund please" }, { role: "assistant", content: "Done." }],
  toolCalls: [], diff: [], costMicroUsd: 1_000, ...over,
});

export const scenarioResult = (scenarioId: string, trials: TrialResult[]): ScenarioResult => {
  const passed = trials.filter((t) => t.passed).length;
  return { scenarioId, workflowId: "refund_request", trials, passRate: trials.length ? passed / trials.length : 0, reliable: trials.length > 0 && passed === trials.length, ci95: [0, 1] };
};

export const sampleDiff = (): StateDiff[] => [{
  table: "refunds", inserted: 1, updated: 0, deleted: 0,
  sample: [
    { change: "insert", pk: { id: "r_o_100" }, before: null, after: { id: "r_o_100", amount: 470 } },
    { change: "update", pk: "o_100", before: { status: "delivered" }, after: { status: "refunded" } },
  ],
}];

export interface ReportOptions {
  /** Appended to the flaky scenario's failing transcript. */
  failingTranscript?: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
  /** Store trials 1-based instead of the engine's 0-based. */
  oneBased?: boolean;
  name?: string;
  runId?: string;
}

/** 3 scenarios, k=2: all-pass, flaky (trial 0 passes, trial 1 fails), policy_conflict (both fail). */
export function makeReport(over: Partial<SandboxRunReport> = {}, opts: ReportOptions = {}): SandboxRunReport {
  const b = opts.oneBased ? 1 : 0;
  const failing = opts.failingTranscript ?? [
    { role: "user" as const, content: "I want my money back" },
    { role: "tool" as const, content: `{"ok":true} ${TRANSCRIPT_MARKER}` },
    { role: "assistant" as const, content: "Refunded $470 without checking." },
  ];
  const flakyFail = trial(SC_FLAKY, b + 1, {
    passed: false, failureAttribution: "agent", error: "agent refunded before verifying identity",
    checks: [
      check({ id: "ok_check", passed: true, detail: "passing check detail" }),
      check({ id: "verify_first", kind: "trajectory", passed: false, severity: "critical", detail: "refund_order called before verify_identity", policyRef: "refund_policy:r2" }),
    ],
    transcript: failing,
    toolCalls: [
      { seq: 1, tool: "lookup_order", args: { order_id: "o_100" }, result: {}, ms: 12 },
      { seq: 2, tool: "refund_order", args: { order_id: "o_100", amount: 47.2 }, result: {}, ms: 30, error: "boom", fault: "http_500" },
    ],
    diff: sampleDiff(),
  });
  const policyTrial = (n: number) => trial(SC_POLICY, n, {
    passed: false, failureAttribution: "agent",
    checks: [check({ id: "deny", passed: false, severity: "high", detail: "refunded an order past the 30 day window", policyRef: "refund_policy:r1" })],
  });
  return {
    runId: opts.runId ?? RUN_ID, draftId: null, name: opts.name ?? "Acme support agent", domain: "e-commerce support", mode: "tool_loop", status: "complete",
    sample: false, createdAt: "2026-06-01T00:00:00.000Z", completedAt: "2026-06-01T00:05:00.000Z", k: 2, versions,
    scenarios: [
      scenario(SC_PASS, "Refund a recent order", "happy_path"),
      scenario(SC_FLAKY, "Refund with identity check", "boundary"),
      scenario(SC_POLICY, "Refund past the window", "policy_conflict"),
    ],
    workflows: [], policies: [{ id: "refund_policy", title: "Refund policy", clauses: [{ id: "r1", text: "30 days" }, { id: "r2", text: "verify identity" }] }],
    results: [
      scenarioResult(SC_PASS, [trial(SC_PASS, b), trial(SC_PASS, b + 1)]),
      scenarioResult(SC_FLAKY, [trial(SC_FLAKY, b), flakyFail]),
      scenarioResult(SC_POLICY, [policyTrial(b), policyTrial(b + 1)]),
    ],
    clusters: [{ id: "cl1", title: "Skips identity check", rootCause: "Agent refunds first", attribution: "agent", severity: "critical", scenarioIds: [SC_FLAKY], trialCount: 1 }],
    verifiedFix: null, media: [], costMicroUsd: 60_000, budgetMicroUsd: 3_000_000,
    ...over,
  };
}

export const hostedTarget = (over: Partial<RunTarget> = {}): RunTarget => ({ mode: "tool_loop", hosted: true, model: "openai/gpt-5-mini", systemPrompt: "You are a support agent.\nBe polite.", ...over });
export const ownTarget = (): RunTarget => ({ mode: "tool_loop", hosted: false });

export const sandboxCtx = (over: Partial<SandboxContext> = {}): SandboxContext => ({
  ownerId: OWNER, ref: { kind: "sandbox_run", id: RUN_ID }, report: makeReport(), target: hostedTarget(), ...over,
});

/** 2 findings (critical + low) and 1 remediation for the critical one. Rows are shaped like findings table rows. */
export function makeJobInput(over: Partial<JobGroundingInput["job"]> = {}): JobGroundingInput {
  return {
    job: { id: JOB_ID, state: "delivered", package: "trace_audit", createdAt: "2026-06-01T00:00:00.000Z", ...over },
    findings: [
      { id: "f-row-1", findingKey: "F1", data: { id: "F1", title: "Leaks customer email", severity: "critical", status: "confirmed", category: "privacy", description: "Agent printed an email", reproductions: 3, evidence: [{ kind: "trace", location: "turn 4", excerpt: "email is ann@example.com" }] } },
      { id: "f-row-2", findingKey: "F2", data: { id: "F2", title: "Slow reply", severity: "low", status: "inconclusive", category: "latency", description: "Took long", evidence: [] } },
    ],
    remediations: [{ id: "rem-1", findingRowId: "f-row-1", kind: "prompt_patch", summary: "Never print emails", patch: "+ Never print emails", rationale: "privacy", verification: { status: "verified" } }],
    report: { summary: "Two findings." },
  };
}

export const jobCtx = (over: Partial<JobGroundingInput["job"]> = {}, ownerId = OWNER): JobContext => ({
  ownerId, ref: { kind: "job", id: JOB_ID }, job: makeJobInput(over),
});

/** ActionDeps with an in-memory store and spy-able fake ports. */
export function makeDeps(now: () => Date = () => new Date("2026-06-02T00:00:00Z")) {
  const store = createMemoryEvalChatStore();
  const draft = (status: "ready" | "generating" | "failed", extraScenarios: string[] = [], validated = true) => ({
    draftId: "drf_1", status, error: status === "failed" ? "gate exploded" : undefined,
    scenarios: [SC_PASS, SC_FLAKY, SC_POLICY, ...extraScenarios].map((id) => ({
      scenario: scenario(id, id, "happy_path"), decision: "accepted" as const, edited: false, validated: id.startsWith("sx_new") ? validated : true, gateReasons: [],
    })),
  });
  const sandbox = {
    getRunReport: vi.fn(async () => null as SandboxRunReport | null),
    getRunTarget: vi.fn(async () => null as RunTarget | null),
    seedSuiteFromRun: vi.fn(async (..._a: unknown[]) => ({ draftId: "drf_1", status: "generating" }) as unknown),
    getDraft: vi.fn(async (..._a: unknown[]) => draft("ready", ["sx_new_1"]) as unknown),
    startRun: vi.fn(async (..._a: unknown[]) => ({ ok: true, runId: "run_new" }) as unknown),
    listRuns: vi.fn(async () => [] as unknown[]),
  };
  const jobs = {
    rerunFinding: vi.fn(async (..._a: unknown[]) => ({ ok: true }) as unknown),
    enableShare: vi.fn(async (..._a: unknown[]) => ({ url: "https://app.example/share/SECRET-TOKEN" })),
  };
  const deps = { store, sandbox, jobs, now } as unknown as ActionDeps & { store: typeof store; sandbox: typeof sandbox; jobs: typeof jobs };
  return { deps, store, sandbox, jobs, draft };
}
