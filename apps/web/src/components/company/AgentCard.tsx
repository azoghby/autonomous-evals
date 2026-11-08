import type { PublicAgentNode } from "@/server/company/queries";
import { humanizeKey, relativeTime } from "./format";

const STATUS_LABEL: Record<string, string> = { ok: "ran", failed: "failed", skipped: "skipped", budget: "paused at budget cap", running: "running" };

function StateDot({ on, managed }: { on: boolean; managed: boolean }) {
  const label = !managed ? "Running" : on ? "On" : "Off";
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase text-fg-2">
      <span aria-hidden className={`size-1.5 rounded-full ${on ? "bg-ok" : "bg-subtle"}`} />
      {label}
    </span>
  );
}

function Activity({ node, now, available }: { node: PublicAgentNode; now: Date; available: boolean }) {
  if (!available) return <p className="t-small text-subtle">Activity unavailable right now.</p>;
  const a = node.activity;
  if (!a) {
    return node.passive ? (
      <p className="t-small text-muted"><span className="font-mono text-fg tabular-nums">{node.passive.count}</span> {node.passive.label} in the last 7 days</p>
    ) : <p className="t-small text-subtle">Activity is tracked in the product, not here.</p>;
  }
  const counts = Object.entries(a.counts).filter(([, v]) => v > 0);
  return (
    <div className="flex flex-col gap-3">
      <p className="t-small text-muted">
        <span className="font-mono text-fg tabular-nums">{a.runs}</span> {a.runs === 1 ? "run" : "runs"} in 7 days
        {a.runs > 0 && <> <span aria-hidden>·</span> <span className="tabular-nums">{a.ok}</span> ok{a.failed > 0 && <>, <span className="tabular-nums">{a.failed}</span> failed</>}</>}
      </p>
      {counts.length > 0 && (
        <ul className="flex flex-wrap gap-x-5 gap-y-1" aria-label="Last 7 days totals">
          {counts.map(([k, v]) => (
            <li key={k} className="t-small text-muted"><span className="font-mono text-fg tabular-nums">{v}</span> {humanizeKey(k)}</li>
          ))}
        </ul>
      )}
      {a.latest ? (
        <p className="t-small border-l border-line-3 pl-3 text-fg-2">
          {a.latest.publicSummary ?? `Last run ${STATUS_LABEL[a.latest.status] ?? a.latest.status}.`}
          <span className="block font-mono text-[11px] uppercase text-subtle">{relativeTime(a.latest.at, now)}</span>
        </p>
      ) : <p className="t-small text-subtle">No runs yet this week.</p>}
    </div>
  );
}

export function AgentCard({ node, byId, now, available, lead }: { node: PublicAgentNode; byId: Map<string, PublicAgentNode>; now: Date; available: boolean; lead?: boolean }) {
  const boss = node.reportsTo ? byId.get(node.reportsTo)?.name : null;
  const on = node.enabled;
  return (
    <article aria-labelledby={`agent-${node.id}`} className={`flex min-w-0 flex-col gap-5 rounded-[4px] border bg-bg-raised p-5 transition-colors duration-150 hover:bg-bg-hover sm:p-6 ${lead ? "border-line-3" : "border-line-2"} ${on ? "" : "opacity-80"}`}>
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[11px] uppercase text-subtle">{node.model}</span>
          <StateDot on={on} managed={node.managed} />
        </div>
        <h3 id={`agent-${node.id}`} className={`text-balance text-fg ${lead ? "t-h3" : "t-h4"}`}>{node.name}</h3>
        <p className="t-small text-muted">{node.role}</p>
        {boss && <p className="font-mono text-[11px] uppercase text-subtle">Reports to {boss}</p>}
      </header>
      <Activity node={node} now={now} available={available} />
      {node.gates.length > 0 && (
        <details className="group border-t border-line-2 pt-3">
          <summary className="cursor-pointer list-none font-mono text-[11px] uppercase text-fg-2 marker:hidden focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
            <span aria-hidden className="mr-2 inline-block transition-transform group-open:rotate-90 motion-reduce:transition-none">›</span>
            {node.gates.length} {node.gates.length === 1 ? "guardrail" : "guardrails"}
            {node.contactsExternally && <span className="ml-2 text-warn">contacts people</span>}
          </summary>
          <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 marker:text-line-3">
            {node.gates.map((g) => <li key={g} className="t-small text-muted">{g}</li>)}
          </ul>
        </details>
      )}
    </article>
  );
}
