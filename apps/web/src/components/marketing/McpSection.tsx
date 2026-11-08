import Link from "next/link";
import { McpTerminal } from "./extras/McpTerminal";
import { OauthSteps } from "./mcp/OauthSteps";
import { NudgeArrow, Reveal, Section, SectionHeader } from "../ui";

const CMD = "claude mcp add --transport http standard-evals https://autonomous-evals.vercel.app/api/mcp/mcp";
const CAN = [
  "No API key: sign in once in your browser",
  "Hire an audit, get a quote, pay",
  "Run sandbox evals from your repo",
] as const;

export function McpSection() {
  return (
    <Section id="mcp" labelledBy="mcp-h" band className="scroll-mt-16 [content-visibility:auto] [contain-intrinsic-size:auto_1100px]">
      <Reveal>
        <SectionHeader
          id="mcp-h"
          index="07"
          eyebrow="MCP"
          title={<>Hire us from your coding agent. <span className="text-muted">One command, sign in once, 13 tools.</span></>}
        />
      </Reveal>
      <Reveal className="mt-12 md:mt-16">
        <OauthSteps />
      </Reveal>
      <Reveal className="mt-12 grid gap-8 md:mt-16 lg:grid-cols-12 lg:gap-8">
        <div className="min-w-0 lg:col-span-8 lg:col-start-5">
          <McpTerminal command={CMD} />
        </div>
        <ul className="flex flex-col gap-3 lg:col-span-4 lg:col-start-1 lg:row-start-1">
          {CAN.map((c) => (
            <li key={c} className="flex items-baseline gap-3 text-[15px] text-fg-2">
              <i aria-hidden className="size-1.5 shrink-0 translate-y-[-2px] bg-subtle" />{c}
            </li>
          ))}
          <li className="mt-3">
            <Link href="/settings/keys" className="group inline-flex items-center gap-1 text-[14px] text-muted underline decoration-line-3 underline-offset-4 hover:text-fg hover:decoration-fg">API key for CI <NudgeArrow /></Link>
          </li>
        </ul>
      </Reveal>
    </Section>
  );
}
