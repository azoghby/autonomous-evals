import type { AgentTaskRunner, AgentTaskSpec } from '../agents/session-service';
import type { ServiceContext } from '../contracts/services';
import { createTrackBServices } from '../evals/service-adapter';
import { JobRefSchema, type Finding } from '../evals/types';
import { renderReport } from '../reporting/render';

export const job = JobRefSchema.parse({ jobId: 'fixture-text', customerId: 'provenance-local', package: 'trace_audit', environment: 'test', isFixture: true });
export const ctx: ServiceContext = { jobId: job.jobId, environment: 'test', budgetMicroUsd: 0, recordCost: async () => {}, recordProgress: async () => {} };
export const trace = JSON.stringify([
  { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'create_event', arguments: '{"title":"Review"}' } }] },
  { role: 'tool', tool_call_id: 'call-1', name: 'create_event', content: 'Error: dependency unavailable <script>bad()</script> ```' },
  { role: 'assistant', content: 'Your review is booked.' },
]);
export function envelope(message: string): any {
  return JSON.parse(message.split('<untrusted_data>')[1]!.split('</untrusted_data>')[0]!);
}
// Mimics the real runner contract: completed means schema validated; malformed output becomes schema_failed.
export function runner(decide: (spec: AgentTaskSpec<unknown>) => unknown): AgentTaskRunner {
  return { async run<T>(spec: AgentTaskSpec<T>) {
    const parsed = spec.output.schema.safeParse(decide(spec as AgentTaskSpec<unknown>));
    const session = { sessionId: 'offline-session', agentId: 'offline-agent', agentVersion: 1, consumedMicroUsd: 0, tokenUsage: {} };
    const cost = { jobId: job.jobId, source: 'naive_session' as const, role: spec.role, externalId: session.sessionId, purpose: spec.purpose, microUsd: 0, measured: true, recordedAt: '2026-11-07T00:00:00Z' };
    if (!parsed.success) return { status: 'schema_failed' as const, taskKey: 'local', issues: parsed.error.issues.map(i => i.message), session, cost };
    return { status: 'completed' as const, taskKey: 'local', output: parsed.data, session, cost };
  } };
}
export const services = (r: AgentTaskRunner) => createTrackBServices({ runner: r, resolveJob: async () => job, operatorSummary: false });
export function artifacts(findings: Finding[], limitations: string[] = []) {
  // Serialize as a customer would; no assertions based only on shared object identity.
  const r = renderReport({ job, generatedAt: '2026-11-07T00:00:00Z', findings, limitations, operatorSummary: null, costs: [], includeHtml: true });
  return { ...r, json: JSON.parse(JSON.stringify(r.json)) };
}
export function verdicts(message: string, evidence: unknown[]) {
  return { verdicts: envelope(message).candidates.map((c: any) => ({ candidate_id: c.candidate_id, verdict: 'confirmed', rationale: 'Checked local evidence.', evidence, defect_note: null })), additional_findings: [] };
}
