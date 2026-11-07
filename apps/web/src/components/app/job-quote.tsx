"use client";
import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { api, dollars, errMsg, PACKAGE_LABEL } from "@/lib/client/api";
import type { QuoteView } from "@/lib/client/types";
import { PER_FINDING_CAP_CENTS, PER_FINDING_CENTS, type Environment, type JobState, type PricingMode } from "@ae/core/contracts/index";
import { Button, Chip, Frame } from "@/components/ui";
import { Banner, cx, ErrorBox } from "./ui";
import { CountUp, Reveal } from "./motion";

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
  const label = "t-eyebrow text-subtle";
  return (
    <Reveal>
      <Frame className="space-y-0">
        {waiting && <div className="border-b border-line-2 px-5 py-4 sm:px-6"><AnimatePresence><Banner key="w" tone="ok">Payment received. Waiting for confirmation, this page updates automatically.</Banner></AnimatePresence></div>}

        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5 border-b border-line-2 p-5 sm:p-8">
          <div>
            <p className={label}>Quote · version {quote.version}</p>
            <h2 className="t-h3 mt-4 text-fg">{PACKAGE_LABEL[quote.package] ?? quote.package}</h2>
            <div className="mt-3 flex flex-wrap items-center gap-2"><Chip tone="muted">Pilot pricing</Chip>{env === "test" && <Chip tone="warn">Test mode</Chip>}</div>
          </div>
          <CountUp value={quote.priceCents} format={(n) => dollars(Math.round(n))} className="font-mono text-[44px] leading-none tracking-[-0.04em] text-fg tabular-nums sm:text-[56px]" />
        </div>

        <div className="grid gap-px bg-line-2 sm:grid-cols-2">
          <div className="bg-bg-raised p-5 sm:p-8">
            <h3 className={label}>Scope</h3>
            <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed text-fg-2">{quote.scopeSummary}</p>
          </div>
          <div className="bg-bg-raised p-5 sm:p-8">
            <h3 className={label}>Deliverables</h3>
            <ul className="mt-3 space-y-2 text-[15px] text-fg-2">
              {quote.deliverables.map((d, i) => <li key={i} className="flex gap-3"><span className="mt-[9px] size-1 shrink-0 bg-accent" aria-hidden />{d}</li>)}
            </ul>
          </div>
        </div>

        <fieldset className="border-t border-line-2 p-5 sm:p-8">
          <legend className="sr-only">Pricing</legend>
          <p className={label} aria-hidden>Pricing</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {([
              { id: "fixed", title: `Fixed ${dollars(quote.priceCents)}`, body: "One flat price, charged when you accept." },
              { id: "per_finding", title: "Pay per confirmed finding", body: `${dollars(PER_FINDING_CENTS)} each, capped at ${dollars(capCents)}. $0 if we find nothing real.` },
            ] as const).map((o) => (
              <label key={o.id} className={cx("block cursor-pointer rounded-[4px] border p-4 transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                mode === o.id ? "border-accent bg-accent-soft" : "border-line-2 hover:border-line-3 hover:bg-bg-hover")}>
                <input type="radio" name="pricingMode" value={o.id} checked={mode === o.id} onChange={() => setMode(o.id)} className="sr-only" />
                <span className="flex items-center gap-3 text-[15px] text-fg">
                  <span aria-hidden className={cx("flex size-4 shrink-0 items-center justify-center rounded-full border", mode === o.id ? "border-accent" : "border-line-3")}>
                    {mode === o.id && <span className="size-2 rounded-full bg-accent" />}
                  </span>{o.title}
                </span>
                <span className="mt-1.5 block pl-7 text-[13px] leading-relaxed text-muted">{o.body}</span>
              </label>
            ))}
          </div>
          {env === "test" && <p className="mt-4 text-xs text-subtle">Test mode: no real money will be charged.</p>}
        </fieldset>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line-2 p-5 sm:p-8">
          <Button size="lg" onClick={accept} disabled={busy || waiting} className="max-sm:w-full">
            {busy ? "Redirecting…" : state === "awaiting_payment" && !waiting ? "Resume payment" : "Accept & pay"} · {mode === "fixed" ? dollars(quote.priceCents) : `up to ${dollars(capCents)}`}
          </Button>
          <AnimatePresence>{error && <ErrorBox key="e" message={error} />}</AnimatePresence>
        </div>
      </Frame>
    </Reveal>
  );
}
