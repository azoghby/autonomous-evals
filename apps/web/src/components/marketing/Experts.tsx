import Link from "next/link";
import { ExpertNetwork } from "./extras/ExpertNetwork";
import { NudgeArrow, Reveal, Section, SectionHeader, Stat } from "../ui";

export function Experts() {
  return (
    <Section id="experts" labelledBy="experts-h" className="[content-visibility:auto] [contain-intrinsic-size:auto_900px]">
      <Reveal>
        <SectionHeader
          id="experts-h"
          index="08"
          eyebrow="Expert network"
          title={<>Domain reviewers when judgment matters. <span className="text-muted">Ask a question or book a call.</span></>}
        />
      </Reveal>
      <Reveal className="mt-14 grid items-center gap-12 md:mt-20 lg:grid-cols-12">
        <div className="lg:col-span-7">
        <div className="grid border-y border-line-2 sm:grid-cols-2">
          <Stat className="py-8 sm:pr-8" label="Short async questions" value="$25" hint="Written questions, answered when it suits the expert." />
          <Stat className="border-t border-line-2 py-8 sm:border-l sm:border-t-0 sm:pl-8" label="15-minute call" value="$75" hint="Pilot rate. Recorded only if you say yes, twice." />
        </div>
        <Link href="/experts" className="group mt-8 inline-flex items-center gap-1 text-[15px] text-fg underline decoration-line-3 underline-offset-4 hover:decoration-fg">Meet the network <NudgeArrow /></Link>
        </div>
        <div className="grid lg:col-span-5"><ExpertNetwork /></div>
      </Reveal>
    </Section>
  );
}
