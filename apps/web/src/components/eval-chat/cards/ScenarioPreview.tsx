"use client";
import type { ScenarioPreviewCard } from "@/lib/eval-chat/types";
import type { DraftScenario, SandboxDraft } from "../../sandbox/contract";
import { useAction } from "../context";
import { humanize, newScenarios, personaLabel } from "../format";
import { ToolFrame } from "../ToolFrame";
import { usePoll } from "../usePoll";
import { CostEstimate } from "./CostEstimate";
import { actionStateLabel, actionTone } from "./actionState";

const parseDraft = (json: unknown): SandboxDraft | null => {
  if (!json || typeof json !== "object" || !("draft" in json)) return null;
  const d = (json as { draft: unknown }).draft;
  return d && typeof d === "object" && "status" in d ? (d as SandboxDraft) : null;
};
const isTerminal = (d: SandboxDraft) => d.status === "ready" || d.status === "failed";

const STAGES = [["generating", "Generating"], ["gating", "Checking gates"], ["ready", "Ready"]] as const;
const GATES = ["Oracle solves it", "Null agents fail it", "Graders catch mutations"] as const;

function Stages({ status }: { status: SandboxDraft["status"] | "loading" }) {
  const idx = status === "ready" ? 2 : status === "gating" ? 1 : 0;
  return (
    <ol className="ec-stages" aria-label="Scenario progress">
      {STAGES.map(([key, label], i) => (
        <li key={key} data-state={status === "failed" ? "idle" : i < idx || status === "ready" ? "done" : i === idx ? "active" : "idle"} aria-current={i === idx && status !== "ready" ? "step" : undefined}>{label}</li>
      ))}
    </ol>
  );
}

function GateMarks({ s }: { s: DraftScenario }) {
  if (s.validated === true) {
    return (
      <div className="ec-gates">
        <ul className="ec-gate-marks">{GATES.map((g) => <li key={g}><span className="ec-mark" data-tone="ok" aria-hidden="true" />{g}</li>)}</ul>
        <p className="ec-status" data-tone="ok"><span className="ec-dot" aria-hidden="true" />Gates passed</p>
      </div>
    );
  }
  if (s.validated === false) {
    const reasons = s.gateReasons?.length ? s.gateReasons : ["The scenario did not pass the automatic gates."];
    return (
      <div className="ec-gates">
        <p className="ec-status" data-tone="danger"><span className="ec-dot" aria-hidden="true" />Gates failed</p>
        <ul className="ec-list">{reasons.map((r, i) => <li key={i}><span className="ec-mark" data-tone="danger" aria-hidden="true" /><span>{r}</span></li>)}</ul>
      </div>
    );
  }
  return <p className="ec-dim">Gate results are not in yet.</p>;
}

function NewScenario({ s }: { s: DraftScenario }) {
  const goal = personaLabel(s.scenario.persona);
  return (
    <div className="ec-scn">
      <p className="ec-row-title">{s.scenario.title}</p>
      <p className="ec-row-sub">{humanize(s.scenario.category)}</p>
      {goal ? <p className="ec-text"><span className="ec-dim">User goal: </span>{goal}</p> : null}
      <GateMarks s={s} />
    </div>
  );
}

export function ScenarioPreview({ data }: { data: ScenarioPreviewCard }) {
  const action = useAction(data);
  const { data: draft, error } = usePoll(`/api/sandbox/drafts/${encodeURIComponent(data.draftId)}`, parseDraft, isTerminal);
  const fresh = draft ? newScenarios(draft.scenarios, data.baseScenarioIds) : [];
  const ready = draft?.status === "ready";
  const validated = fresh.length > 0 && fresh.every((s) => s.validated === true);
  const blocked = !draft ? "Waiting for the scenario to be generated." : draft.status === "failed" ? "Generation failed. Ask for a different brief." : !ready ? "Waiting for the gate checks to finish." : fresh.length === 0 ? "No new scenario came out of this brief." : !validated ? "The new scenario did not pass the gates. Ask for a different brief." : null;
  const runLabel = data.scope === "all" ? `Run all with k=${data.k}` : "Run scenario";

  return (
    <ToolFrame title="New scenario" stateLabel={actionStateLabel(action.status)} tone={actionTone(action.status)}>
      <p className="ec-meta">{humanize(data.category)} · {data.scope === "all" ? "re-runs the whole suite" : "runs only the new scenario"} · k={data.k}</p>
      <p className="ec-text"><span className="ec-dim">Brief: </span>{data.brief}</p>
      <Stages status={draft?.status ?? "loading"} />
      {draft?.status === "failed" ? <p className="ec-text" data-tone="danger" role="alert">{draft.error ?? "Generation failed."}</p> : null}
      {ready ? fresh.map((s) => <NewScenario key={s.scenario.id} s={s} />) : draft?.status === "failed" ? null : <div className="ec-skel" aria-hidden="true" />}
      {error && !draft ? <p className="ec-dim">Could not check the scenario yet. Retrying.</p> : null}
      <CostEstimate estimate={data.estimate} action={action} confirmLabel={runLabel} canConfirm={blocked === null} blockedReason={blocked} />
    </ToolFrame>
  );
}
