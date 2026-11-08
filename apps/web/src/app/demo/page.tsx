import type { Metadata } from "next";
import { PageShell } from "@/components/ui";
import { DemoStage } from "@/components/demo/DemoStage";
import { toRecording } from "@/components/demo/recording";
import raw from "../../../../../data/demo/real-run.json";

export const metadata: Metadata = {
  title: "Watch a real eval run",
  description:
    "Replays of real recorded sandbox evaluations: open-source customer-service agents from OpenAI and Google, run from their own code on frontier models, with a simulated customer and every tool call hitting a real Postgres branch, graded on database state.",
};

const recording = toRecording(raw);

export default function DemoPage() {
  return (
    <PageShell active="/demo">
      <header className="mb-8">
        <p className="t-eyebrow mb-4 flex items-center gap-2 text-muted"><span className="eyebrow-mark" aria-hidden />Live replay</p>
        <h1 className="t-h1 text-balance">Watch a real eval run</h1>
        <p className="t-lead mt-4 max-w-[64ch] text-[16px]">
          Real open-source agents, running their own code on today&apos;s models. A simulated customer talks to them, every tool call
          hits a real Postgres branch, and we grade what changed in the database, not what the agent said.
        </p>
      </header>
      <DemoStage recording={recording} />
    </PageShell>
  );
}
