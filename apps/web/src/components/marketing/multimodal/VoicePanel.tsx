import { Chip, Frame } from "../../ui";
import { Waveform } from "./Waveform";

const CHECKS = [
  { name: "Perception", detail: "order id matched", ok: true },
  { name: "Latency", detail: "p50 590 · p95 910 ms", ok: true },
  { name: "Turn-taking", detail: "0 talk-overs, 1 barge-in handled", ok: true },
  { name: "Hallucinated confirmation", detail: "none", ok: true },
] as const;

export function VoicePanel() {
  return (
    <Frame className="bg-bg-raised p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <span className="t-eyebrow text-muted">Voice · simulated caller</span>
        <Chip tone="muted">Sample</Chip>
      </div>

      <div className="mt-6 space-y-3">
        <div>
          <div className="mb-1.5 flex justify-between font-mono text-[11px] uppercase text-subtle"><span>Caller · gateway TTS</span><span>eleven-v4</span></div>
          <Waveform count={56} seed={1} tone="caller" />
        </div>
        <div>
          <div className="mb-1.5 flex justify-between font-mono text-[11px] uppercase text-subtle"><span>Agent reply · audio</span><span>scribe-v2</span></div>
          <Waveform count={40} seed={4} tone="agent" delay={700} />
        </div>
        <p className="sr-only">Animated waveform of the simulated caller speaking, followed by the agent&apos;s spoken reply. Decorative; the transcript below carries the content.</p>
      </div>

      <div className="mm-rise mt-6 space-y-3 border-t border-line-2 pt-5 text-[14px] leading-relaxed" style={{ ["--i" as string]: 0 }}>
        <p><span className="mr-2 font-mono text-[11px] uppercase text-subtle">Caller</span><span className="text-fg-2">&ldquo;Hi, my order number is <mark className="mm-gt">A-1042</mark>, the blender arrived cracked.&rdquo;</span></p>
        <p><span className="mr-2 font-mono text-[11px] uppercase text-subtle">Agent</span><span className="text-fg-2">&ldquo;Sorry about that. I&apos;ve pulled up order <mark className="mm-gt">A-1042</mark>&hellip;&rdquo;</span> <span className="font-mono text-[11px] text-subtle">transcribed</span></p>
      </div>

      <div className="mm-rise mt-5 flex flex-wrap items-center gap-x-5 gap-y-2" style={{ ["--i" as string]: 1 }}>
        <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-ok"><svg aria-hidden viewBox="0 0 12 12" className="size-3"><path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>perception: order id matched</span>
        <span className="font-mono text-[12px] text-fg-2 tabular-nums">TTFA <span className="text-fg">640 ms</span></span>
      </div>

      <ul className="mm-rise mt-6 divide-y divide-line-2 border-t border-line-2" style={{ ["--i" as string]: 2 }}>
        {CHECKS.map((c) => (
          <li key={c.name} className="flex items-baseline justify-between gap-4 py-2.5 text-[13px]">
            <span className="text-fg-2">{c.name}</span>
            <span className="text-right font-mono text-[12px] text-muted">{c.detail}</span>
          </li>
        ))}
      </ul>
    </Frame>
  );
}
