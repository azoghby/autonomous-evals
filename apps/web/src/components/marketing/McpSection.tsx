import Link from "next/link";
import { NudgeArrow, Reveal, Section } from "../ui";

const CMD = "claude mcp add --transport http standard-evals https://standard-evals.vercel.app/api/mcp/mcp";

export function McpSection() {
  return (
    <Section id="mcp" labelledBy="mcp-h" className="scroll-mt-16">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-12 lg:gap-16">
        <Reveal className="flex flex-col gap-4 lg:col-span-5">
          <h2 id="mcp-h" className="t-h2 text-balance text-fg">Works where you build.</h2>
          <p className="t-lead max-w-[30rem]">Add it to your coding agent in one line, then build sandboxes and run trials from chat.</p>
        </Reveal>
        <Reveal className="flex min-w-0 flex-col gap-5 lg:col-span-7">
          <pre style={{ overflowX: "auto" }} className="rounded-[4px] border border-line-2 bg-bg-raised p-4 font-mono text-[13px] leading-relaxed text-fg-2"><code><span className="select-none text-subtle">$ </span>{CMD}</code></pre>
          <p className="t-small text-muted">
            Prefer CI? Use the API with a key.{" "}
            <Link href="/settings/keys" className="group inline-flex items-center gap-1 text-fg-2 underline decoration-line-3 underline-offset-4 hover:text-fg hover:decoration-fg">Get an API key <NudgeArrow /></Link>
          </p>
        </Reveal>
      </div>
    </Section>
  );
}
