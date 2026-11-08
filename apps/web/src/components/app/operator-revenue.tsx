"use client";
import type { ReactNode } from "react";
import { dollars, microUsd } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";
import type { RevenueMetrics } from "@/server/revenue-metrics";
import type { EnvMrr, GrossMargin } from "@/server/revenue-metrics-core";
import { Frame } from "@/components/ui";
import { Banner, Btn, Metric, MetricStrip, Section, Spinner } from "./ui";
import { Stagger, StaggerItem } from "./motion";

const NO_LIVE = "$0 — no live revenue yet";
const pct = (m: GrossMargin): string => (m.marginPct === null ? "n/a" : `${m.marginPct}%`);
const money = (cents: number, emptyLabel?: string): string => (cents === 0 && emptyLabel ? emptyLabel : dollars(cents));

function Figures({ mrr, revenue30dCents, margin, costMicroUsd, empty }: { mrr: EnvMrr; revenue30dCents: number; margin: GrossMargin; costMicroUsd: number; empty?: string }) {
  return (
    <MetricStrip>
      <Metric label="MRR" value={money(mrr.mrrCents, empty)} note={`ARR ${dollars(mrr.arrCents)}`} />
      <Metric label="Paying customers" value={String(mrr.activeCustomers)} note={`Pro ${mrr.byPlan.pro.count} / Scale ${mrr.byPlan.scale.count}`} />
      <Metric label="30d revenue" value={money(revenue30dCents, empty)} note="Collected, last 30 days" />
      <Metric label="30d cost" value={microUsd(costMicroUsd)} note="Model + infra costs table" />
      <Metric label="Gross margin" value={pct(margin)} note={margin.marginPct === null ? "No revenue, margin undefined" : `Profit ${dollars(margin.grossProfitCents)}`} />
    </MetricStrip>
  );
}

function Rows({ rows, empty }: { rows: Array<[string, string]>; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-subtle">{empty}</p>;
  return (
    <ul className="divide-y divide-line text-sm">
      {rows.map(([k, v]) => <li key={k} className="flex min-h-11 items-center justify-between gap-3 py-2"><span className="text-muted">{k}</span><span className="font-mono tabular-nums text-fg">{v}</span></li>)}
    </ul>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <Frame className="h-full p-5 sm:p-6"><h3 className="mb-4 font-mono text-[11px] uppercase text-subtle">{title}</h3>{children}</Frame>;
}

/** Operator Revenue tab (GET /api/operator/revenue). Live and Stripe test-mode figures are kept apart on purpose. */
export function OperatorRevenue() {
  const { data, error, loading, reload } = useFetch<RevenueMetrics>("/api/operator/revenue");
  if (loading) return <div className="flex items-center gap-2 text-muted"><Spinner size={14} /> Loading revenue</div>;
  if (error || !data) {
    return <Banner tone="bad"><span className="block text-fg">Could not load revenue</span><span className="block text-muted">{error?.message}</span><Btn variant="ghost" size="sm" className="mt-3" onClick={() => void reload()}>Retry</Btn></Banner>;
  }
  const { mrr, mrrUnknown } = { mrr: data.mrr, mrrUnknown: data.mrr.unknown };
  const planRows: Array<[string, string]> = (["pro", "scale"] as const).map((p) => [`${p} (live)`, `${mrr.live.byPlan[p].count} / ${dollars(mrr.live.byPlan[p].mrrCents)}`]);
  const runRows: Array<[string, string]> = Object.entries(data.runs30d.byStatus).map(([k, v]) => [k, String(v)]);
  const custRows: Array<[string, string]> = Object.entries(data.customersByPlan).map(([k, v]) => [k, String(v)]);

  return (
    <Stagger className="space-y-12">
      <StaggerItem>
        <Section title="Live revenue" aside={<span className="font-mono text-[11px] text-subtle">Stripe mode: {data.stripeMode}</span>}>
          <Figures mrr={mrr.live} revenue30dCents={data.revenue30dCents.live} margin={data.grossMargin} costMicroUsd={data.cost30dMicroUsd} empty={NO_LIVE} />
          {mrr.live.mrrCents === 0 && data.revenue30dCents.live === 0 && <p className="mt-3 text-sm text-muted">{NO_LIVE}. Margin is undefined until live revenue exists; costs above are real.</p>}
          <p className="mt-3 text-xs text-subtle">MRR uses list prices for active, trialing and past-due Pro/Scale subscriptions. Enterprise contracts are not estimated.</p>
          {mrrUnknown.activeCustomers > 0 && <p className="mt-2 text-xs text-subtle">{mrrUnknown.activeCustomers} subscriber(s) have no purchase record, so their mode is unknown ({dollars(mrrUnknown.mrrCents)} MRR). Not counted as live.</p>}
        </Section>
      </StaggerItem>

      <StaggerItem>
        <Section title="Stripe test mode" aside={<span className="font-mono text-[11px] text-subtle">test-mode data, not revenue</span>}>
          <Banner tone="warn">Test-mode data, not revenue. Nothing here was paid by a customer.</Banner>
          <div className="mt-4"><Figures mrr={mrr.test} revenue30dCents={data.revenue30dCents.test} margin={data.testGrossMargin} costMicroUsd={data.cost30dMicroUsd} /></div>
          <p className="mt-3 text-xs text-subtle">Test margin is illustrative only: fake revenue against real costs.</p>
        </Section>
      </StaggerItem>

      <StaggerItem>
        <div className="grid gap-6 md:grid-cols-3">
          <Panel title="Plan mix (live subscribers / MRR)"><Rows rows={planRows} empty="No live subscribers." /></Panel>
          <Panel title={`Runs, last ${data.windowDays}d`}>
            <Rows rows={[["total", String(data.runs30d.total)], ["trials", String(data.runs30d.trialsTotal)], ...runRows]} empty="No runs." />
          </Panel>
          <Panel title="Signed-up customers by plan"><Rows rows={custRows} empty="No customers yet." /></Panel>
        </div>
        <p className="mt-3 font-mono text-[11px] text-subtle">Generated {new Date(data.generatedAt).toLocaleString()}</p>
      </StaggerItem>
    </Stagger>
  );
}
