/**
 * Shape of data/demo/real-run.json: one REAL recorded sandbox run (real model output), replayed by /demo.
 * Written by scripts/record-demo-run.ts. All `t` values are ms relative to the start of their trial.
 */

export type DemoStoryRole = "clean" | "boundary" | "injection";

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

export interface DemoRun {
  schema: "demo-run-v1";
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
