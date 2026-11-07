"use client";
import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { api, dollars, errMsg, PACKAGE_LABEL } from "@/lib/client/api";
import type { QuoteView } from "@/lib/client/types";
import { PER_FINDING_CAP_CENTS, PER_FINDING_CENTS, type Environment, type JobState, type PricingMode } from "@ae/core/contracts/index";
import { Banner, Btn, Chip, ErrorBox, Block } from "./ui";
import { CountUp, Reveal, Stagger, StaggerItem } from "./motion";

export function QuoteCard({ jobId, quote, jobEnv, state, paid }: { jobId: string; quote: QuoteView; jobEnv: Environment; state: JobState; paid: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const env = quote.environment ?? jobEnv;
  const [mode, setMode] = useState<PricingMode>("fixed");
  const capCents = PER_FINDING_CAP_CENTS[quote.package] ?? 0;

  async function accept() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ checkoutUrl: string }>(`/api/jobs/${jobId}/accept-quote`, { method: "POST", json: { quoteVersion: quote.version, pricingMode: mode } });
      window.location.assign(r.checkoutUrl);
    } catch (e) { setError(errMsg(e)); setBusy(false); }
  }

  const waiting = state === "awaiting_payment" && paid;
  return (
    <Reveal>
      <Block className="space-y-8">
        <AnimatePresence>{waiting && <Banner key="w" tone="ok">Payment received. Waiting for confirmation, this page updates automatically.</Banner>}</AnimatePresence>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-subtle">Quote · version {quote.version}</p>
            <h2 className="mt-2 text-xl font-medium">{PACKAGE_LABEL[quote.package] ?? quote.package}</h2>
            <div className="mt-2 flex gap-4"><Chip tone="muted">Pilot pricing</Chip>{env === "test" && <Chip tone="warn">Test mode</Chip>}</div>
          </div>
          <CountUp value={quote.priceCents} format={(n) => dollars(Math.round(n))} className="font-mono text-5xl font-medium tabular-nums tracking-tight text-accent-bright" />
        </div>
        <Stagger className="grid gap-8 sm:grid-cols-2" delay={0.15}>
          <StaggerItem>
            <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-subtle">Scope</h3>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg/90">{quote.scopeSummary}</p>
          </StaggerItem>
          <StaggerItem>
            <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-subtle">Deliverables</h3>
            <ul className="mt-2 space-y-1.5 text-sm text-fg/90">
              {quote.deliverables.map((d, i) => <li key={i} className="flex gap-3"><span className="mt-2 h-px w-3 shrink-0 bg-subtle" aria-hidden />{d}</li>)}
            </ul>
          </StaggerItem>
        </Stagger>
        {env === "test" && <p className="text-xs text-subtle">Test mode: no real money will be charged.</p>}
        <AnimatePresence>{error && <ErrorBox key="e" message={error} />}</AnimatePresence>
        <fieldset className="border-t border-line pt-6">
          <legend className="font-mono text-[11px] uppercase tracking-[0.14em] text-subtle">Pricing</legend>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {([
              { id: "fixed", title: `Fixed ${dollars(quote.priceCents)}`, body: "One flat price, charged when you accept." },
              { id: "per_finding", title: "Pay per confirmed finding", body: `${dollars(PER_FINDING_CENTS)} each, capped at ${dollars(capCents)}. $0 if we find nothing real.` },
            ] as const).map((o) => (
              <label key={o.id} className={`block cursor-pointer rounded-md border p-4 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${mode === o.id ? "border-accent bg-bg-raised" : "border-line hover:border-line-strong"}`}>
                <input type="radio" name="pricingMode" value={o.id} checked={mode === o.id} onChange={() => setMode(o.id)} className="sr-only" />
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span aria-hidden className={`h-2 w-2 rounded-full ${mode === o.id ? "bg-accent-bright" : "bg-line-strong"}`} />{o.title}
                </span>
                <span className="mt-1.5 block pl-4 text-xs leading-relaxed text-muted">{o.body}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Btn onClick={accept} loading={busy} disabled={waiting}>
          {state === "awaiting_payment" && !waiting ? "Resume payment" : "Accept & pay"} · {mode === "fixed" ? dollars(quote.priceCents) : `up to ${dollars(capCents)}`}
        </Btn>
      </Block>
    </Reveal>
  );
}
