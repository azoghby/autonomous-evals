import { Frame, Reveal, Section, SectionHeader } from "../ui";

const DIFF = [
  { k: "ctx", t: "  # support-bot system prompt" },
  { k: "ctx", t: "  You help customers with orders and returns." },
  { k: "del", t: "- When a customer asks for a refund, confirm it is done." },
  { k: "add", t: "+ Only say a refund is done after issue_refund returns" },
  { k: "add", t: "+ status=ok. Otherwise say it is pending and why." },
  { k: "ctx", t: "  Never reveal internal order notes." },
] as const;
const tone = { ctx: "text-subtle", del: "bg-danger/10 text-danger", add: "bg-ok/10 text-ok" } as const;

function Bar({ label, pass, total, tone: c }: { label: string; pass: number; total: number; tone: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between font-mono text-[11px] uppercase text-subtle">
        <span>{label}</span><span className="text-fg tabular-nums">{pass}/{total} pass</span>
      </div>
      <div className="grid grid-cols-3 gap-1" role="img" aria-label={`${label}: ${pass} of ${total} reproductions pass`}>
        {Array.from({ length: total }, (_, i) => <i key={i} className={`h-2 ${i < pass ? c : "bg-line-2"}`} />)}
      </div>
    </div>
  );
}

export function Fixes() {
  return (
    <Section id="fixes" labelledBy="fixes-h" band className="[content-visibility:auto] [contain-intrinsic-size:auto_900px]">
      <Reveal>
        <SectionHeader
          id="fixes-h"
          index="03"
          eyebrow="Validated fixes"
          title={<>We do not stop at the bug. <span className="text-muted">Every proposed fix is retested before you see it.</span></>}
          lead="A patch only reaches the report if the failing case passes and the rest of the suite does not regress."
        />
      </Reveal>
      <Reveal className="mt-14 grid gap-6 md:mt-20 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Frame className="min-w-0 bg-bg-raised">
          <div className="flex h-10 items-center justify-between border-b border-line-2 px-4 font-mono text-[11px] uppercase text-subtle">
            <span className="truncate">Proposed patch · system_prompt.md</span><span className="text-ok">+2 −1</span>
          </div>
          <pre className="t-data overflow-x-auto py-3"><code>{DIFF.map((l, i) => <span key={i} className={`block whitespace-pre px-4 ${tone[l.k]}`}>{l.t}</span>)}</code></pre>
        </Frame>
        <Frame className="min-w-0 flex flex-col justify-between gap-8 bg-bg-raised p-5 sm:p-6">
          <div className="flex flex-col gap-6">
            <span className="font-mono text-[11px] uppercase text-subtle">Verification · finding F-2</span>
            <Bar label="Before patch" pass={0} total={3} tone="bg-danger" />
            <Bar label="After patch" pass={3} total={3} tone="bg-ok" />
          </div>
          <dl className="flex items-baseline justify-between border-t border-line-2 pt-4">
            <dt className="font-mono text-[11px] uppercase text-subtle">Regressions</dt>
            <dd className="font-mono text-[32px] leading-none tracking-[-0.04em] text-fg">0</dd>
          </dl>
        </Frame>
      </Reveal>
    </Section>
  );
}
