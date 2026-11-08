import type { CSSProperties } from "react";
import Link from "next/link";
import { Eyebrow, NudgeArrow, Reveal, Section } from "../ui";

const CMD = "claude mcp add --transport http standard-evals https://standard-evals.vercel.app/api/mcp/mcp";
const PANEL_STYLE = { "--edge": "linear-gradient(90deg, var(--cyan), var(--accent-bright) 40%, transparent 85%)", "--g": "var(--cyan-glow)" } as CSSProperties;

/** Compact MCP band: one-line install for coding agents, API fallback. */
export function McpSection() {
  return (
    <Section id="mcp" labelledBy="mcp-h" className="scroll-mt-16 !py-16 md:!py-24">
      <Reveal className="panel lg:!flex-row lg:items-center lg:gap-16" style={PANEL_STYLE}>
        <div aria-hidden className="panel-glow" />
        <div className="flex flex-col gap-4 lg:w-5/12">
          <Eyebrow>MCP</Eyebrow>
          <h2 id="mcp-h" className="t-h3 text-fg">Works where you build.</h2>
          <p className="t-small max-w-[38ch] text-muted">Add it to your coding agent in one line, then build sandboxes and run trials from chat.</p>
        </div>
        <div className="mt-6 flex min-w-0 flex-col gap-4 lg:mt-0 lg:w-7/12">
          <pre style={{ overflowX: "auto" }} className="rounded-[4px] border border-line-2 bg-bg p-4 font-mono text-[12.5px] leading-relaxed text-fg-2"><code><span className="select-none text-cyan">$ </span>{CMD}</code></pre>
          <p className="t-small text-muted">
            Prefer CI? Use the API with a key.{" "}
            <Link href="/settings/keys" className="group inline-flex items-center gap-1 text-fg-2 underline decoration-line-3 underline-offset-4 hover:text-fg hover:decoration-fg">Get an API key <NudgeArrow /></Link>
          </p>
        </div>
      </Reveal>
    </Section>
  );
}
