import { Reveal, Section, SectionHeader, Terminal, type TerminalLine } from "../ui";

const STEPS = [
  ["Submit", "A trace, or an endpoint."],
  ["Qualify & quote", "Scoped and priced in minutes."],
  ["Test", "Suites run under a hard budget."],
  ["Find & fix", "Failures confirmed, patches verified."],
  ["Report", "Evidence you can re-run."],
] as const;

const TRACE: TerminalLine[] = [
  { prefix: "$", text: "ae run support-bot --package workflow_eval", tone: "default" },
  { text: "qualify   endpoint reachable, 6 tools discovered", tone: "muted" },
  { text: "quote     $5.00 fixed · budget capped at $3.00", tone: "muted" },
  { prefix: "T1", text: "call lookup_order(id=\"A-1042\")", tone: "default" },
  { prefix: "T1", text: "ok  order found, status=delivered", tone: "ok" },
  { prefix: "T7", text: "user: \"please refund it\"", tone: "default" },
  { prefix: "T7", text: "assistant: \"Done, your refund has been issued.\"", tone: "default" },
  { prefix: "✕", text: "refund issued without calling refund tool", tone: "danger" },
  { prefix: "▶", text: "reproduced 3/3 · finding F-2 · severity high", tone: "accent" },
  { prefix: "ok", text: "report ready", tone: "ok" },
];

export function HowItWorks() {
  return (
    <Section id="how" labelledBy="how-h" band className="scroll-mt-16">
      <Reveal>
        <SectionHeader
          id="how-h"
          index="01"
          eyebrow="How it works"
          title={<>Five stages, all run by agents. <span className="text-muted">Each one has a budget and an audit trail.</span></>}
        />
      </Reveal>
      <Reveal className="mt-14 md:mt-20">
        <ol className="grid grid-cols-1 border-y border-line-2 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map(([t, d], i) => (
            <li key={t} className={`flex flex-col gap-3 border-line-2 py-6 sm:px-5 sm:first:pl-0 ${i > 0 ? "border-t sm:border-t-0" : ""} ${i % 2 === 1 ? "sm:border-l" : ""} lg:border-l lg:first:border-l-0 lg:border-t-0 ${i >= 2 ? "sm:border-t lg:border-t-0" : ""}`}>
              <span className="font-mono text-[11px] text-accent-text">0{i + 1}</span>
              <h3 className="t-h3 text-fg">{t}</h3>
              <p className="t-small text-muted">{d}</p>
            </li>
          ))}
        </ol>
      </Reveal>
      <Reveal className="mt-8">
        <Terminal title="run · support-bot · workflow_eval" lines={TRACE} animate />
      </Reveal>
    </Section>
  );
}
