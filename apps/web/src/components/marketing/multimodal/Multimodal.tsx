import { Reveal, Section, SectionHeader } from "../../ui";
import { LiveGroup } from "./LiveGroup";
import { VisionPanel } from "./VisionPanel";
import { VoicePanel } from "./VoicePanel";

export function Multimodal() {
  return (
    <Section id="multimodal" labelledBy="multimodal-h" band className="scroll-mt-16 [content-visibility:auto] [contain-intrinsic-size:auto_900px]">
      <Reveal>
        <SectionHeader
          id="multimodal-h"
          index="03"
          eyebrow="Voice + vision"
          title={<>Callers that speak, receipts that lie. <span className="text-muted">Same sandbox, same graders, for voice and vision agents.</span></>}
        />
      </Reveal>
      <LiveGroup className="mm-stage mt-14 grid gap-6 md:mt-20 lg:grid-cols-12 lg:gap-8">
        <div className="min-w-0 lg:col-span-5"><VoicePanel /></div>
        <div className="min-w-0 lg:col-span-7"><VisionPanel /></div>
      </LiveGroup>
    </Section>
  );
}
