/**
 * Shape of data/demo/real-run.json: REAL recorded sandbox runs (real model output), one per agent model, replayed by
 * /demo. Written by scripts/record-demo-run.ts. All `t` values are ms relative to the start of their trial.
 */

export type DemoStoryRole = "clean" | "boundary" | "injection" | "exchange" | "trap";

export type DemoEvent =
  | { t: number; type: "user"; text: string }
  | { t: number; type: "assistant"; text: string; latencyMs: number }
  | {
      t: number;
      type: "tool";
      seq: number;
      tool: string;
      effect: "read" | "write" | "external" | "unknown";
      args: unknown;
      result: unknown;
      error?: string;
      fault?: string;
      ms: number;
      executed?: boolean;
    };

export interface DemoCheck {
  id: string;
  kind: "state" | "trajectory" | "rubric" | "collateral" | "injection" | "perception" | "latency";
  passed: boolean;
  severity: "critical" | "high" | "medium" | "low";
  detail: string;
  policyRef?: string;
}

/** sample rows: { change: "insert"|"update"|"delete", pk, before, after } */
export interface DemoDiff {
  table: string;
  inserted: number;
  updated: number;
  deleted: number;
  sample: Array<Record<string, unknown>>;
}

export interface DemoTrial {
  trial: number;
  variant: string;
  passed: boolean;
  failureAttribution?: string;
  error?: string;
  /** Wall time: branch ready → conversation end. */
  conversationMs: number;
  /** Time to branch the Neon world for this trial. */
  branchMs: number;
  /** Time spent grading (deterministic SQL checks + judge). */
  gradeMs: number;
  /** Our spend for this trial (simulator + judge + attribution), USD. */
  costUsd: number;
  /** Agent-under-test spend, USD (from gateway usage). */
  agentCostUsd: number;
  stopReason?: string;
  events: DemoEvent[];
  checks: DemoCheck[];
  diff: DemoDiff[];
  outbox: Array<Record<string, unknown>>;
}

export interface DemoScenario {
  id: string;
  title: string;
  /** Public benchmark task id when the scenario comes from one (e.g. "33" for τ²-bench retail task 33). */
  taskId?: string;
  /** Short story label shown in the picker (e.g. "Partial-cancel trap"). */
  storyLabel?: string;
  storyRole: DemoStoryRole;
  category: string;
  workflowId: string;
  persona: { goal: string; style: string; knowledge: string[] };
  faults: Array<{ tool: string; onCall: number; fault: string }>;
  gate: { accepted: boolean; oracle: boolean; nullAgents: Array<{ agent: string; passed: boolean }>; mutations: Array<{ kind: string; flipped: boolean }> };
  k: number;
  passRate: number;
  /** pass^k: every counted trial passed. */
  reliable: boolean;
  ci95: [number, number];
  costUsd: number;
  trials: DemoTrial[];
}

/** The real open-source agent app under test (credit + honest note on how it was run). */
export interface DemoSource {
  /** Stable key used to group runs of the same agent app (e.g. "openai-cs-agents"). */
  key: string;
  name: string;
  url: string;
  license: string;
  /** e.g. "OpenAI Agents SDK", "Google ADK". */
  framework?: string;
  /** Honest caveat, e.g. "Tools patched to call our sandbox; prompts and agent logic untouched." */
  note: string;
}

/** The file: real agent apps × models, each one recorded run. */
export interface DemoRecording {
  schema: "demo-recording-v1";
  recordedAt: string;
  runs: DemoRun[];
  totalCostUsd: number;
}

/** One (agent app × model) recorded run. */
export interface DemoRun {
  schema: "demo-run-v1";
  source?: DemoSource;
  /** Honest provenance line. */
  provenance: string;
  recordedAt: string;
  agent: { model: string; via: string; systemPrompt: string };
  simulatorModel: string;
  judgeModel: string;
  env: {
    id: string;
    name: string;
    domain: string;
    tools: Array<{ name: string; effect: string; description: string }>;
    tables: string[];
    policies: Array<{ id: string; title: string; clauses: Array<{ id: string; text: string }> }>;
    buildMs: number;
  };
  versions: Record<string, string>;
  scenarios: DemoScenario[];
  summary: {
    scenarios: number;
    trials: number;
    passAt1: number;
    passAt1Ci95: [number, number];
    passHatK: number;
    attackSuccessRate: number | null;
    ourCostUsd: number;
    agentCostUsd: number;
    totalCostUsd: number;
    wallMs: number;
  };
}
