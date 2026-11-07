"use client";
import type { ReactNode } from "react";
import { useFetch } from "@/lib/client/use-fetch";
import type { InfraReport } from "@/server/infra";
import { Banner, Btn, Chip, Spinner } from "./ui";
import { Stagger, StaggerItem } from "./motion";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "none");

function Panel({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <StaggerItem className="border-t border-white/10 pt-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-cream/50">{title}</h3>
        {note && <span className="text-xs text-cream/35">{note}</span>}
      </div>
      {children}
    </StaggerItem>
  );
}

const Muted = ({ children }: { children: ReactNode }) => <p className="text-sm text-cream/55">{children}</p>;

/** Operator-only Neon infra panel (GET /api/operator/infra). Mount inside the operator page. */
export function OperatorInfra() {
  const { data, error, loading, reload } = useFetch<InfraReport>("/api/operator/infra");

  if (loading) return <div className="flex items-center gap-2 text-cream/70"><Spinner size={14} /> Loading infrastructure</div>;
  if (error?.status === 403) return null;
  if (error || !data) {
    return <Banner tone="bad"><span className="block text-cream">Could not load infrastructure</span><span className="block text-cream/60">{error?.message}</span><Btn variant="ghost" className="mt-3" onClick={() => void reload()}>Retry</Btn></Banner>;
  }

  const { neon } = data;
  return (
    <section aria-label="Infrastructure">
      <Stagger className="grid gap-x-12 gap-y-8 lg:grid-cols-2">
        <Panel title="Neon project">
          {neon ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <Chip tone="muted">{neon.region ?? "unknown region"}</Chip>
              <Chip tone="muted">PG {neon.pgVersion ?? "?"}</Chip>
              <Chip tone="muted">{neon.branchCount} branches</Chip>
              <code className="text-xs text-cream/40">{neon.projectId}</code>
            </div>
          ) : <Muted>{data.neonError ?? "Neon API unavailable"}</Muted>}
        </Panel>

        <Panel title="Job branches" note="TTL = Neon auto-delete safety net">
          {!neon ? <Muted>Unavailable</Muted> : neon.jobBranches.length === 0 ? <Muted>No job branches right now.</Muted> : (
            <ul className="space-y-1.5 text-sm">
              {neon.jobBranches.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-xs">{b.name}</span>
                  <span className="shrink-0 text-xs text-cream/60">{b.expiresAt ? `expires ${fmt(b.expiresAt)}` : <Chip tone="warn">no TTL</Chip>}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Recent snapshots">
          {!neon ? <Muted>Unavailable</Muted> : neon.snapshots.length === 0 ? <Muted>No snapshots yet.</Muted> : (
            <ul className="space-y-1.5 text-sm">
              {neon.snapshots.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3">
                  <span className="truncate">{s.name}</span>
                  <span className="shrink-0 text-xs text-cream/60">{fmt(s.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Slowest queries" note="pg_stat_statements, top 5 by mean time">
          {data.slowQueriesError ? <Muted>{data.slowQueriesError}</Muted> : data.slowQueries.length === 0 ? <Muted>No statements recorded yet.</Muted> : (
            <ul className="space-y-2">
              {data.slowQueries.map((q, i) => (
                <li key={i} className="text-xs">
                  <code className="line-clamp-2 break-all text-cream/80">{q.query}</code>
                  <div className="mt-0.5 tabular-nums text-cream/50">{q.meanMs} ms mean, {q.calls} calls</div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </Stagger>
    </section>
  );
}
