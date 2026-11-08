import { Eyebrow } from "@/components/ui";

const STEPS = [
  { n: "01", title: "Connect", time: "10 min or less", body: "Give us an endpoint, point your tools at a sandbox URL, boot a repo, or share a voice socket or staging stack." },
  { n: "02", title: "Describe your world", time: "A few minutes", body: "Say what your agent does, which tools it has, and which rules it must follow. We build a matching sandbox." },
  { n: "03", title: "Review the suite", time: "5 min or less", body: "We generate scenarios and attacks. You read them, edit them and approve what runs." },
  { n: "04", title: "Run and read the report", time: "Under 15 min in total", body: "Every scenario runs several times. The report grades each trial on what changed in the world." },
];

export function Steps() {
  return (
    <section aria-labelledby="sb-how" className="py-16 md:py-24">
      <div className="flex flex-col gap-5">
        <Eyebrow>How it works</Eyebrow>
        <h2 id="sb-how" className="t-h2 max-w-[26ch] text-fg text-balance">
          Four steps, under fifteen minutes. <span className="text-muted">No test harness to write.</span>
        </h2>
      </div>
      <div className="mt-10 grid grid-cols-1 border-l border-t border-line-2 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s) => (
          <div key={s.n} className="flex min-w-0 flex-col gap-4 border-b border-r border-line-2 p-6">
            <span className="t-data text-muted">{s.n}</span>
            <h3 className="t-h4 text-fg">{s.title}</h3>
            <p className="t-small break-words text-fg-2">{s.body}</p>
            <span className="t-eyebrow mt-auto text-accent-text">{s.time}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
