"use client";
import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { api, dollars, errMsg, PACKAGE_LABEL } from "@/lib/client/api";
import type { QuoteView } from "@/lib/client/types";
import type { Environment, JobState } from "@ae/core/contracts/index";
import { Banner, Btn, Chip, ErrorBox, Block } from "./ui";
import { CountUp, Reveal, Stagger, StaggerItem } from "./motion";

export function QuoteCard({ jobId, quote, jobEnv, state, paid }: { jobId: string; quote: QuoteView; jobEnv: Environment; state: JobState; paid: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const env = quote.environment ?? jobEnv;

  async function accept() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ checkoutUrl: string }>(`/api/jobs/${jobId}/accept-quote`, { method: "POST", json: { quoteVersion: quote.version } });
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
            <p className="text-xs uppercase tracking-[0.14em] text-cream/50">Quote · version {quote.version}</p>
            <h2 className="mt-2 text-xl font-medium">{PACKAGE_LABEL[quote.package] ?? quote.package}</h2>
            <div className="mt-2 flex gap-4"><Chip tone="muted">Pilot pricing</Chip>{env === "test" && <Chip tone="warn">Test mode</Chip>}</div>
          </div>
          <CountUp value={quote.priceCents} format={(n) => dollars(Math.round(n))} className="text-5xl font-semibold tabular-nums tracking-tight" />
        </div>
        <Stagger className="grid gap-8 sm:grid-cols-2" delay={0.15}>
          <StaggerItem>
            <h3 className="text-xs uppercase tracking-[0.14em] text-cream/50">Scope</h3>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-cream/80">{quote.scopeSummary}</p>
          </StaggerItem>
          <StaggerItem>
            <h3 className="text-xs uppercase tracking-[0.14em] text-cream/50">Deliverables</h3>
            <ul className="mt-2 space-y-1.5 text-sm text-cream/80">
              {quote.deliverables.map((d, i) => <li key={i} className="flex gap-3"><span className="mt-2 h-px w-3 shrink-0 bg-cream/30" aria-hidden />{d}</li>)}
            </ul>
          </StaggerItem>
        </Stagger>
        {env === "test" && <p className="text-xs text-cream/50">Test mode: no real money will be charged.</p>}
        <AnimatePresence>{error && <ErrorBox key="e" message={error} />}</AnimatePresence>
        <Btn onClick={accept} loading={busy} disabled={waiting}>
          {state === "awaiting_payment" && !waiting ? "Resume payment" : "Accept & pay"} · {dollars(quote.priceCents)}
        </Btn>
      </Block>
    </Reveal>
  );
}
