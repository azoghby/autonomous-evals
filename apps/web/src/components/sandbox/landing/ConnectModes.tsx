import { CONNECT_MODES } from "@/components/sandbox/contract";
import { Eyebrow } from "@/components/ui";

export function ConnectModes() {
  return (
    <section aria-labelledby="sb-modes" className="py-16 md:py-24">
      <div className="flex flex-col gap-5">
        <Eyebrow>Connect modes</Eyebrow>
        <h2 id="sb-modes" className="t-h2 max-w-[26ch] text-fg text-balance">
          Five ways to plug in. <span className="text-muted">Pick the one that fits how your agent runs.</span>
        </h2>
      </div>
      <div className="mt-10 border-t border-line-2">
        <div aria-hidden className="t-eyebrow hidden grid-cols-12 gap-6 border-b border-line-2 py-3 text-muted lg:grid">
          <span className="col-span-2">Mode</span>
          <span className="col-span-5">What you give us</span>
          <span className="col-span-2">Who runs the loop</span>
          <span className="col-span-3">Effort</span>
        </div>
        {CONNECT_MODES.map((m) => (
          <div key={m.mode} className="grid min-w-0 grid-cols-1 gap-2 border-b border-line-2 py-5 lg:grid-cols-12 lg:gap-6">
            <h3 className="t-h4 min-w-0 text-fg lg:col-span-2">{m.label}</h3>
            <div className="min-w-0 lg:col-span-5">
              <p className="t-small break-words text-fg-2">{m.summary}</p>
              <p className="t-small mt-1 break-words text-muted">Best for: {m.bestFor}</p>
            </div>
            <p className="t-small min-w-0 break-words text-fg lg:col-span-2"><span className="t-eyebrow mr-2 text-muted lg:hidden">Loop</span>{m.loop}</p>
            <p className="t-small min-w-0 break-words text-fg lg:col-span-3"><span className="t-eyebrow mr-2 text-muted lg:hidden">Effort</span>{m.effort}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
