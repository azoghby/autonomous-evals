"use client";
import { useId } from "react";
import { Button, Field } from "@/components/ui";
import type { SandboxDraft } from "../contract";

type Props = { draft: SandboxDraft; k: number; onK: (k: number) => void; starting: boolean; onStart: () => void };

export function RunStep({ draft, k, onK, starting, onStart }: Props) {
  const uid = useId();
  const accepted = draft.scenarios.filter((s) => s.decision === "accepted").length;
  return (
    <div className="max-w-xl space-y-6">
      <Field id={`${uid}-k`} label="Trials per scenario (k)" type="number" inputMode="numeric" min={1} max={8} value={k} onChange={(e) => onK(Math.min(8, Math.max(1, Math.round(Number(e.target.value)) || 1)))}
        hint="Each scenario runs k times. pass^k means every one of the k trials passes, so it measures reliability, not luck. Higher k is stricter and costs more." />
      <dl className="grid grid-cols-2 gap-px border border-line-2 bg-line-2 text-sm">
        <div className="bg-bg p-4"><dt className="t-eyebrow text-subtle">Accepted scenarios</dt><dd className="mt-1 text-2xl text-fg">{accepted}</dd></div>
        <div className="bg-bg p-4"><dt className="t-eyebrow text-subtle">Total trials</dt><dd className="mt-1 text-2xl text-fg">{accepted * k}</dd></div>
      </dl>
      {draft.sample && <p className="text-sm text-warn">These are sample scenarios, so the run is a demonstration and not an evaluation of your agent.</p>}
      {accepted === 0 && <p className="text-sm text-muted">Accept at least one scenario in the previous step to start.</p>}
      <Button size="lg" onClick={onStart} disabled={accepted === 0 || starting}>{starting ? "Starting…" : `Start run (${accepted * k} trials)`}</Button>
    </div>
  );
}
