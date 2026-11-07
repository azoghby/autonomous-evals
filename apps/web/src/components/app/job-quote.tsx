"use client";
import { useState } from "react";
import { api, dollars, errMsg, PACKAGE_LABEL } from "@/lib/client/api";
import type { QuoteView } from "@/lib/client/types";
import type { Environment, JobState } from "@ae/core/contracts/index";
import { Btn, Chip, ErrorBox, Glass, Spinner } from "./ui";

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
    <div className="space-y-4">
      {waiting && (
        <div role="status" className="flex items-center gap-3 rounded-2xl border border-[#7fd1a8]/40 bg-[#7fd1a8]/10 px-4 py-3 text-sm text-[#7fd1a8]">
          <Spinner size={16} /> Payment received. Waiting for confirmation, this page updates automatically.
        </div>
      )}
      <Glass>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">Quote: {PACKAGE_LABEL[quote.package] ?? quote.package}</h2>
              <Chip tone="info">Pilot pricing</Chip>
              {env === "test" && <Chip tone="warn">TEST MODE</Chip>}
            </div>
            <p className="mt-1 text-xs text-cream/60">Version {quote.version}</p>
          </div>
          <div className="text-4xl font-semibold tabular-nums text-coral">{dollars(quote.priceCents)}</div>
        </div>
        <h3 className="mt-5 text-sm font-semibold">Scope</h3>
        <p className="mt-1 whitespace-pre-wrap text-sm text-cream/80">{quote.scopeSummary}</p>
        <h3 className="mt-5 text-sm font-semibold">Deliverables</h3>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-cream/80">
          {quote.deliverables.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
        {env === "test" && <p className="mt-4 text-xs text-[#ffc56b]">Test mode: no real money will be charged.</p>}
        {error && <div className="mt-4"><ErrorBox message={error} /></div>}
        <Btn className="mt-6" onClick={accept} loading={busy} disabled={waiting}>
          {state === "awaiting_payment" && !waiting ? "Resume payment" : "Accept & pay"} · {dollars(quote.priceCents)}
        </Btn>
      </Glass>
    </div>
  );
}
