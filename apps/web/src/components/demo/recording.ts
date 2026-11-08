import type { DemoRecording, DemoRun } from "./demo-run-types";

/** Normalizes data/demo/real-run.json: a DemoRecording, or a legacy single DemoRun. Never throws. */
export function toRecording(raw: unknown): DemoRecording {
  const r = (raw ?? {}) as Partial<DemoRecording> & Partial<DemoRun>;
  if (Array.isArray(r.runs)) {
    const runs = r.runs.filter((x) => Array.isArray(x?.scenarios) && x.scenarios.length > 0);
    return { schema: "demo-recording-v1", recordedAt: r.recordedAt ?? "", runs, totalCostUsd: r.totalCostUsd ?? 0 };
  }
  if (Array.isArray(r.scenarios) && r.scenarios.length > 0) {
    const run = r as DemoRun;
    return { schema: "demo-recording-v1", recordedAt: run.recordedAt, runs: [run], totalCostUsd: run.summary?.totalCostUsd ?? 0 };
  }
  return { schema: "demo-recording-v1", recordedAt: "", runs: [], totalCostUsd: 0 };
}
