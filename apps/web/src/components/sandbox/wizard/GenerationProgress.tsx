import { Spinner } from "@/components/ui";
import type { SuiteStatus } from "../contract";

const COPY: Partial<Record<SuiteStatus, { title: string; detail: string }>> = {
  generating: { title: "Generating scenarios…", detail: "We are designing test scenarios from your world's tools, data and policies." },
  gating: { title: "Validating scenarios against the sandbox…", detail: "Each scenario is checked: a reference solution must pass it and do-nothing agents must fail it." },
};

/** Progress panel shown while an engine draft is generating or gating. Announced politely to screen readers. */
export function GenerationProgress({ status, costMicroUsd }: { status: SuiteStatus; costMicroUsd?: number }) {
  const copy = COPY[status] ?? COPY.generating!;
  return (
    <div role="status" aria-live="polite" className="space-y-3 border border-line-2 p-5">
      <p className="flex items-center gap-2 text-[15px] text-fg"><Spinner /> {copy.title}</p>
      <p className="text-sm text-muted">{copy.detail}</p>
      <p className="text-sm text-muted">This usually takes one to four minutes. You can keep this tab open; we check every few seconds and move on when the suite is ready.</p>
      {costMicroUsd !== undefined && costMicroUsd > 0 && (
        <p className="font-mono text-xs tabular-nums text-subtle">Model spend so far: ${(costMicroUsd / 1_000_000).toFixed(3)}</p>
      )}
    </div>
  );
}
