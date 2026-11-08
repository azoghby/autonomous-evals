import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { clientIp, rateLimit } from "@/server/rate-limit";
import { loadSharedReport } from "@/server/share";
import type { RedactedFinding } from "@/server/share-core";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Verified report · Standard Evals",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

const SEV: Record<string, string> = { critical: "text-[#FF5C5C]", high: "text-[#FF8A3D]", medium: "text-[#F2C94C]", low: "text-white/60" };
const PKG: Record<string, string> = { trace_audit: "Trace Audit", text_eval: "Text Eval", workflow_eval: "Workflow Eval", version_comparison: "Version Comparison" };

function Fix({ f }: { f: NonNullable<RedactedFinding["fix"]> }) {
  const label = f.verification === "verified" ? "Verified fix" : f.verification === "partially_verified" ? "Partially verified" : "Not verified";
  return (
    <div className="mt-3 border-l-2 border-[#2F6BFF] pl-3 text-sm text-white/80">
      <p><span className="font-medium text-[#2F6BFF]">{label}.</span> {f.summary}</p>
      <p className="mt-1 font-mono text-xs text-white/60">{f.before.passed}/{f.before.total} passing before &rarr; {f.after.passed}/{f.after.total} after</p>
    </div>
  );
}

export default async function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const h = await headers();
  const rl = await rateLimit(`share-page:${clientIp(new Request("http://x", { headers: h }))}`, 60, 60);
  if (!rl.ok) return <main className="min-h-screen bg-[#0A0A0B] p-8 text-white"><p>Too many requests. Try again in {rl.retryAfter}s.</p></main>;
  const { token } = await params;
  const r = await loadSharedReport(token);
  if (!r) notFound();
  const delivered = r.deliveredAt ? new Date(r.deliveredAt).toISOString().slice(0, 10) : "n/a";

  return (
    <main className="min-h-screen bg-[#0A0A0B] px-4 py-12 text-white">
      <article className="mx-auto max-w-3xl">
        {r.isSample && (
          <p role="note" className="mb-6 border border-[#2F6BFF] bg-[#2F6BFF]/10 px-4 py-2 text-sm">Sample / test data. This report was not produced for a live customer engagement.</p>
        )}
        <p className="font-mono text-xs uppercase tracking-widest text-[#2F6BFF]">Standard Evals &middot; Verified report</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">{PKG[r.package] ?? r.package}</h1>
        <p className="mt-1 text-white/60">Delivered {delivered}</p>

        <dl className="mt-8 grid grid-cols-2 gap-px bg-white/15 sm:grid-cols-5">
          {([["critical", r.counts.critical], ["high", r.counts.high], ["medium", r.counts.medium], ["low", r.counts.low], ["fixed", r.fixedCount]] as const).map(([k, v]) => (
            <div key={k} className="bg-[#0A0A0B] p-4">
              <dt className="text-xs uppercase tracking-wide text-white/60">{k}</dt>
              <dd className={`text-3xl font-semibold tabular-nums ${SEV[k] ?? "text-[#2F6BFF]"}`}>{v}</dd>
            </div>
          ))}
        </dl>

        <h2 className="mt-12 text-xl font-semibold">Findings ({r.total})</h2>
        {r.findings.length === 0 && <p className="mt-3 text-white/60">No confirmed findings.</p>}
        <ul className="mt-4 space-y-4">
          {r.findings.map((f, i) => (
            <li key={i} className="border border-white/15 p-4">
              <p className="text-xs uppercase tracking-wide">
                <span className={SEV[f.severity]}>{f.severity}</span>
                <span className="text-white/60"> &middot; {f.category.replace(/_/g, " ")} &middot; {f.isOpen ? "open" : "fixed"}</span>
              </p>
              <p className="mt-1 font-medium">{f.title}</p>
              {f.fix && <Fix f={f.fix} />}
            </li>
          ))}
        </ul>
        <p className="mt-12 text-xs text-white/50">Evidence, endpoints, prompts and customer identity are withheld from this public view.</p>
      </article>
    </main>
  );
}
