import Link from "next/link";
import { PRICE_CENTS } from "@ae/core/contracts/index";
import { McpTerminal } from "./extras/McpTerminal";
import { NudgeArrow, Reveal, Section, SectionHeader } from "../ui";

const CMD = `claude mcp add --transport http autonomous-evals https://autonomous-evals.vercel.app/api/mcp/mcp --header "Authorization: Bearer ae_..."`;
const CAN = ["Get a quote for a job", "Submit a job and pay by key", "Fetch the finished report"] as const;

export function McpSection() {
  return (
    <Section id="mcp" labelledBy="mcp-h" band className="scroll-mt-16 [content-visibility:auto] [contain-intrinsic-size:auto_900px]">
      <Reveal>
        <SectionHeader
          id="mcp-h"
          index="05"
          eyebrow="MCP"
          title={<>Hire us from your agent. <span className="text-muted">One command adds Standard Evals as a tool.</span></>}
        />
      </Reveal>
      <Reveal className="mt-14 grid gap-8 md:mt-20 lg:grid-cols-12 lg:gap-8">
        <div className="min-w-0 lg:col-span-8 lg:col-start-5">
          <McpTerminal command={CMD} quote={`$${PRICE_CENTS.trace_audit / 100}`} />
        </div>
        <ul className="flex flex-col gap-3 lg:col-span-4 lg:col-start-1 lg:row-start-1">
          {CAN.map((c) => (
            <li key={c} className="flex items-baseline gap-3 text-[15px] text-fg-2">
              <i aria-hidden className="size-1.5 shrink-0 translate-y-[-2px] bg-subtle" />{c}
            </li>
          ))}
          <li className="mt-3">
            <Link href="/settings/keys" className="group inline-flex items-center gap-1 text-[15px] text-fg underline decoration-line-3 underline-offset-4 hover:decoration-fg">Create an API key <NudgeArrow /></Link>
          </li>
        </ul>
      </Reveal>
    </Section>
  );
}
