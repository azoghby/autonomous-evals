import Link from "next/link";
import type { DemoRun, DemoTrial } from "@/components/demo/demo-run-types";
import raw from "../../../../../data/demo/real-run.json";
import { Button, NudgeArrow, Reveal, Section } from "../ui";

const run = raw as unknown as DemoRun;
const MAX_LINE = 96;

type Line = { who: "user" | "agent" | "tool"; text: string };

const clip = (s: string) => {
  const flat = s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE - 1)}…` : flat;
};

/** First passing trial of the first scenario: the excerpt is real recorded output, never invented. */
function excerpt(): { lines: Line[]; trial?: DemoTrial } {
  const trial = run.scenarios.flatMap((s) => s.trials).find((t) => t.passed && t.events.length > 0);
  if (!trial) return { lines: [] };
  const lines: Line[] = [];
  for (const e of trial.events) {
    if (lines.length >= 5) break;
    if (e.type === "user") lines.push({ who: "user", text: clip(e.text) });
    else if (e.type === "assistant") lines.push({ who: "agent", text: clip(e.text) });
    else if (!lines.some((l) => l.who === "tool" && l.text.startsWith(e.tool))) lines.push({ who: "tool", text: e.tool });
  }
  return { lines, trial };
}

export function DemoTeaser() {
  const { lines, trial } = excerpt();
  const passed = trial?.checks.filter((c) => c.passed).length ?? 0;
  return (
    <Section id="demo" labelledBy="demo-h" band className="scroll-mt-16">
      <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-16">
        <Reveal className="flex flex-col gap-6 lg:col-span-5">
          <h2 id="demo-h" className="t-h2 text-balance text-fg">A real run, replayed. <span className="text-muted">Nothing scripted.</span></h2>
          <p className="t-lead max-w-[30rem]">
            {run.agent.model.replace(/^[^/]+\//, "")} handles a support queue. Watch every message, tool call and database change as it happened.
          </p>
          <div><Button href="/demo" variant="outline" className="group">Watch the run <NudgeArrow /></Button></div>
        </Reveal>
        <Reveal className="lg:col-span-7">
          <Link href="/demo" aria-label="Watch the recorded run" className="ls-card block rounded-[4px] border border-line-2 bg-bg-raised p-5 sm:p-6">
            <ul className="flex flex-col gap-3 font-mono text-[13px] leading-relaxed">
              {lines.map((l, i) => (
                <li key={i} className="flex gap-4">
                  <span className={`w-12 shrink-0 uppercase ${l.who === "tool" ? "text-accent-text" : "text-subtle"}`}>{l.who}</span>
                  <span className={`min-w-0 break-words ${l.who === "tool" ? "text-fg-2" : "text-fg"}`}>{l.text}</span>
                </li>
              ))}
            </ul>
            {trial ? (
              <div className="mt-6 flex items-center gap-3 border-t border-line pt-4 font-mono text-xs uppercase text-ok">
                <span aria-hidden className="size-1.5 rounded-full bg-ok" />
                {passed}/{trial.checks.length} database and policy checks passed
              </div>
            ) : null}
          </Link>
        </Reveal>
      </div>
    </Section>
  );
}
