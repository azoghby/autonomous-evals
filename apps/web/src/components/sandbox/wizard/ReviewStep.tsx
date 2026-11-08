"use client";
import { Button, Chip } from "@/components/ui";
import type { SandboxDraft, ScenarioReviewInput } from "../contract";
import { ScenarioCard } from "./ScenarioCard";

type Props = { draft: SandboxDraft; busyId: string | null; onReview: (scenarioId: string, input: ScenarioReviewInput) => void; onAcceptAll: () => void };

function EnvSummary({ draft }: { draft: SandboxDraft }) {
  const { tools, tables, policies } = draft.environment;
  return (
    <section aria-label="Environment summary" className="grid gap-px border border-line-2 bg-line-2 sm:grid-cols-3">
      {[
        { label: "Tools", items: tools.map((t) => t.name) },
        { label: "Tables", items: tables },
        { label: "Policies", items: policies.map((p) => p.title) },
      ].map((c) => (
        <div key={c.label} className="min-w-0 bg-bg p-4">
          <h3 className="t-eyebrow text-subtle">{c.label} ({c.items.length})</h3>
          <p className="mt-1 text-sm text-fg-2 break-words">{c.items.length ? c.items.join(", ") : "None"}</p>
        </div>
      ))}
    </section>
  );
}

export function ReviewStep({ draft, busyId, onReview, onAcceptAll }: Props) {
  const pending = draft.scenarios.filter((s) => s.decision !== "accepted").length;
  const known = new Set(draft.environment.workflows.map((w) => w.id));
  const groups = [
    ...draft.environment.workflows.map((w) => ({ id: w.id, name: w.name, description: w.description, items: draft.scenarios.filter((s) => s.scenario.workflowId === w.id) })),
    { id: "_other", name: "Other scenarios", description: "", items: draft.scenarios.filter((s) => !known.has(s.scenario.workflowId)) },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="space-y-8">
      {draft.sample && (
        <div role="note" className="border border-warn/50 px-4 py-3 text-sm text-warn">
          <strong className="font-medium">Sample scenarios</strong> — the suite generator isn&apos;t connected yet; these are fixture examples, not generated from your inputs.
        </div>
      )}
      <EnvSummary draft={draft} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{draft.scenarios.length} scenarios across {groups.length} {groups.length === 1 ? "workflow" : "workflows"}. Accept the ones you want to run.</p>
        <Button variant="outline" size="sm" onClick={onAcceptAll} disabled={pending === 0 || busyId !== null}>Accept all</Button>
      </div>
      {groups.map((g) => (
        <section key={g.id} aria-labelledby={`wf-${g.id}`} className="space-y-3">
          <div className="min-w-0">
            <h3 id={`wf-${g.id}`} className="t-h4 text-fg break-words">{g.name} <Chip tone="muted" className="align-middle">{g.items.length}</Chip></h3>
            {g.description && <p className="mt-1 text-sm text-muted break-words">{g.description}</p>}
          </div>
          <div className="space-y-3">
            {g.items.map((it) => (
              <ScenarioCard key={it.scenario.id} item={it} sample={draft.sample} busy={busyId === it.scenario.id || busyId === "*"} onReview={(input) => onReview(it.scenario.id, input)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
