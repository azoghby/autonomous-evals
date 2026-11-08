"use client";
import { useId, useState } from "react";
import { Button, Chip, Field } from "@/components/ui";
import { CATEGORY_LABELS, type DraftScenario, type ScenarioReviewInput } from "../contract";

type Props = { item: DraftScenario; sample: boolean; busy: boolean; onReview: (input: ScenarioReviewInput) => void };

const DECISION_TONE = { pending: "muted", accepted: "ok", rejected: "danger" } as const;
const FAULT_LABELS: Record<string, string> = {
  http_500: "returns a server error", timeout: "times out", empty_result: "returns nothing",
  stale_data: "returns stale data", rate_limited: "is rate limited", injected_instruction: "returns planted instructions",
};

/** Plain-English bullets for what a passing run must do. */
export function assertionLines(s: DraftScenario["scenario"]): string[] {
  const lines = [
    ...s.stateAssertions.map((a) => a.description),
    ...s.trajectoryAssertions.map((a) => a.description),
    ...s.requiredOutputs.map((o) => `${o.description} (must mention: ${o.mustMention.join(", ")})`),
    ...s.rubric.map((r) => r.description),
  ];
  return s.expectRefusal ? ["Success = refuses or escalates", ...lines] : lines;
}

function fixtureLines(s: DraftScenario["scenario"]): string[] {
  const rows = (s.fixtureSql.match(/\binsert\s+into\b/gi) ?? []).length;
  return [
    ...(rows > 0 ? [`Seeds ${rows} extra ${rows === 1 ? "record set" : "record sets"} in the sandbox database`] : []),
    ...s.faults.map((f) => `Tool ${f.tool} ${FAULT_LABELS[f.fault] ?? f.fault} (call ${f.onCall})`),
    ...s.attachments.map((a) => `Sends ${a.kind}: ${a.prompt}`),
  ];
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="min-w-0">
      <h4 className="t-eyebrow mb-1 text-subtle">{title}</h4>
      <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg-2 break-words">{items.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </div>
  );
}

export function ScenarioCard({ item, sample, busy, onReview }: Props) {
  const { scenario: s, decision } = item;
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);
  const [goal, setGoal] = useState(s.persona.goal);

  const save = () => {
    if (!title.trim() || !goal.trim()) return;
    onReview({ decision, edits: { title: title.trim(), personaGoal: goal.trim() } });
    setEditing(false);
  };
  const cancel = () => { setTitle(s.title); setGoal(s.persona.goal); setEditing(false); };

  return (
    <article aria-labelledby={`${uid}-t`} className="min-w-0 space-y-4 border border-line-2 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="neutral">{CATEGORY_LABELS[s.category]}</Chip>
        {sample && <Chip tone="warn">Sample</Chip>}
        {s.oracleValidated ? <Chip tone="ok">Oracle validated</Chip> : <Chip tone="warn">Not oracle-validated</Chip>}
        {item.edited && <Chip tone="muted">Edited</Chip>}
        <Chip tone={DECISION_TONE[decision]} variant="plain" dot className="ml-auto">{decision}</Chip>
      </div>

      {editing ? (
        <div className="space-y-3">
          <Field id={`${uid}-et`} label="Title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} error={title.trim() ? undefined : "Title is required"} />
          <Field id={`${uid}-eg`} multiline rows={3} label="Simulated user's goal" maxLength={1000} value={goal} onChange={(e) => setGoal(e.target.value)} className="[&_textarea]:w-full" error={goal.trim() ? undefined : "Goal is required"} />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={busy}>Save edits</Button>
            <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
          </div>
        </div>
      ) : (
        <>
          <h3 id={`${uid}-t`} className="t-h4 break-words text-fg">{s.title}</h3>
          <p className="text-sm text-fg-2 break-words">
            <span className="text-subtle">{s.persona.name}{s.persona.adversarial ? " (adversarial)" : ""} · {s.persona.modality} · {s.persona.style}. </span>
            Goal: {s.persona.goal}
          </p>
        </>
      )}

      <Bullets title="Setup" items={fixtureLines(s)} />
      <Bullets title="Pass if" items={assertionLines(s)} />

      {!editing && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <Button size="sm" variant={decision === "accepted" ? "secondary" : "outline"} aria-pressed={decision === "accepted"} disabled={busy} onClick={() => onReview({ decision: "accepted" })}>Accept</Button>
          <Button size="sm" variant={decision === "rejected" ? "secondary" : "outline"} aria-pressed={decision === "rejected"} disabled={busy} onClick={() => onReview({ decision: "rejected" })}>Reject</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setTitle(s.title); setGoal(s.persona.goal); setEditing(true); }}>Edit</Button>
        </div>
      )}
    </article>
  );
}
