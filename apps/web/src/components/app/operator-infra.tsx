"use client";
import type { ReactNode } from "react";
import { useFetch } from "@/lib/client/use-fetch";
import type { InfraReport } from "@/server/infra";
import { Chip as UiChip, Frame } from "@/components/ui";
import { Banner, Btn, MarkLabel, Spinner } from "./ui";
import { Stagger, StaggerItem } from "./motion";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "none");

function Panel({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <StaggerItem>
      <Frame className="h-full p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <MarkLabel as="h3">{title}</MarkLabel>
          {note && <span className="font-mono text-[11px] text-subtle">{note}</span>}
        </div>
        {children}
      </Frame>
    </StaggerItem>
  );
}

const Muted = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted">{children}</p>;
const rows = "divide-y divide-line text-sm";
const row = "flex min-h-11 items-center justify-between gap-3 py-2";

/** Operator-only Neon infra panel (GET /api/operator/infra). Mount inside the operator page. */
export function OperatorInfra() {
  const { data, error, loading, reload } = useFetch<InfraReport>("/api/operator/infra");

  if (loading) return <div className="flex items-center gap-2 text-muted"><Spinner size={14} /> Loading infrastructure</div>;
  if (error?.status === 403) return null;
  if (error || !data) {
    return <Banner tone="bad"><span className="block text-fg">Could not load infrastructure</span><span className="block text-muted">{error?.message}</span><Btn variant="ghost" size="sm" className="mt-3" onClick={() => void reload()}>Retry</Btn></Banner>;
  }

  const { neon } = data;
  return (
    <section aria-label="Infrastructure">
      <Stagger className="grid gap-6 lg:grid-cols-2">
        <Panel title="Neon project">
          {neon ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <UiChip tone="muted">{neon.region ?? "unknown region"}</UiChip>
                <UiChip tone="muted">PG {neon.pgVersion ?? "?"}</UiChip>
                <UiChip tone="muted">{neon.branchCount} branches</UiChip>
              </div>
              <code className="block break-all font-mono text-xs text-subtle">{neon.projectId}</code>
            </div>
          ) : <Muted>{data.neonError ?? "Neon API unavailable"}</Muted>}
        </Panel>

        <Panel title="Job branches" note="TTL = Neon auto-delete safety net">
          {!neon ? <Muted>Unavailable</Muted> : neon.jobBranches.length === 0 ? <Muted>No job branches right now.</Muted> : (
            <ul className={rows}>
              {neon.jobBranches.map((b) => (
                <li key={b.id} className={row}>
                  <span className="truncate font-mono text-xs" title={b.name}>{b.name}</span>
                  <span className="shrink-0 font-mono text-xs text-muted">{b.expiresAt ? `expires ${fmt(b.expiresAt)}` : <UiChip tone="warn">no TTL</UiChip>}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Recent snapshots">
          {!neon ? <Muted>Unavailable</Muted> : neon.snapshots.length === 0 ? <Muted>No snapshots yet.</Muted> : (
            <ul className={rows}>
              {neon.snapshots.map((s) => (
                <li key={s.id} className={row}>
                  <span className="truncate" title={s.name}>{s.name}</span>
                  <span className="shrink-0 font-mono text-xs text-muted">{fmt(s.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Slowest queries" note="pg_stat_statements, top 5 by mean time">
          {data.slowQueriesError ? <Muted>{data.slowQueriesError}</Muted> : data.slowQueries.length === 0 ? <Muted>No statements recorded yet.</Muted> : (
            <ul className={rows}>
              {data.slowQueries.map((q, i) => (
                <li key={i} className="py-3 text-xs">
                  <code className="line-clamp-2 break-all font-mono text-fg-2">{q.query}</code>
                  <div className="mt-1 font-mono tabular-nums text-subtle">{q.meanMs} ms mean, {q.calls} calls</div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </Stagger>
    </section>
  );
}
