// Placeholder: Track A worker W3 implements the full jobWorkflow (see docs/TRACK_A_PLAN.md §4).
export async function jobWorkflow(jobId: string) {
  "use workflow";
  return { jobId, status: "not_implemented" as const };
}
