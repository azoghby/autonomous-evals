import { Pipeline } from "./how-it-works/Pipeline";
import { Reveal, Section, SectionHeader, Terminal, type TerminalLine } from "../ui";

const STEPS = [
  { title: "Submit", body: "A trace, or an endpoint.", detail: "trace · endpoint" },
  { title: "Qualify & quote", body: "Scoped and priced in minutes.", detail: "6 tools · $5.00 fixed" },
  { title: "Test", body: "Suites run under a hard budget.", detail: "32 scenarios · 24 attacks" },
  { title: "Find & fix", body: "Failures confirmed, patches verified.", detail: "3/3 reproduced · 2/4 → 4/4" },
  { title: "Report", body: "Evidence you can re-run.", detail: "report · PR #42" },
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
        <Pipeline steps={STEPS} />
      </Reveal>
      <Reveal className="mt-8">
        <Terminal title="run · support-bot · workflow_eval" lines={TRACE} animate />
      </Reveal>
    </Section>
  );
}
