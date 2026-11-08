"use client";
import { NOVA, NovaAvatar } from "./NovaAvatar";
import type { ConversationStatus, NovaUIMessage } from "./nova-types";

type StepState = "done" | "active" | "todo" | "blocked";
const STEPS = [
  { t: "Collect", d: "Agent, tools, optional schema and policies" },
  { t: "Build", d: "Sandbox world and gated scenarios" },
  { t: "Run", d: "k trials per scenario against simulated customers" },
  { t: "Report", d: "pass@1, pass^k, Wilson interval, clusters" },
] as const;

/** Where the conversation is in collect -> build -> run -> report, from its status and the parts already shown. */
export function stepStates(status: ConversationStatus, messages: NovaUIMessage[]): StepState[] {
  const hasRun = messages.some((m) => m.parts.some((p) => p.type === "tool-runProgress"));
  const current = status === "building" ? 1 : status === "running" ? 2 : status === "reported" ? 4 : status === "blocked" ? (hasRun ? 2 : 1) : 0;
  return STEPS.map((_, i) => (i < current ? "done" : i === current ? (status === "blocked" ? "blocked" : "active") : "todo"));
}

export function RunRail({ status, messages }: { status: ConversationStatus; messages: NovaUIMessage[] }) {
  const states = stepStates(status, messages);
  return (
    <aside className="nv-rail" aria-label="About Nova and your run">
      <div className="nv-rail-id">
        <NovaAvatar size={36} />
        <div><b>{NOVA.name}</b><span>{NOVA.role}</span></div>
      </div>
      <p>{NOVA.bio}</p>
      <section aria-labelledby="nv-rail-steps">
        <h2 id="nv-rail-steps" className="nv-label mb-3">Your run</h2>
        <ol className="nv-steps">
          {STEPS.map((s, i) => (
            <li key={s.t} className="nv-step" data-s={states[i]} aria-current={states[i] === "active" ? "step" : undefined}>
              <span className="nv-step-n" aria-hidden="true">{i + 1}</span>
              <div><b>{s.t}</b><span>{states[i] === "blocked" ? "Waiting on a founder" : s.d}</span></div>
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="nv-rail-rules" className="mt-auto">
        <h2 id="nv-rail-rules" className="nv-label mb-2">House rules</h2>
        <p>{NOVA.name} never asks for API keys, only starts runs you confirm, and sends anything over your plan&apos;s budget to a founder first.</p>
      </section>
    </aside>
  );
}

export function RunStrip({ status, messages }: { status: ConversationStatus; messages: NovaUIMessage[] }) {
  const states = stepStates(status, messages);
  return (
    <nav className="nv-strip" aria-label="Run progress">
      <NovaAvatar size={22} />
      <span className="text-[13px] text-fg">{NOVA.name}</span>
      <ol>
        {STEPS.map((s, i) => <li key={s.t} data-s={states[i]} aria-current={states[i] === "active" ? "step" : undefined}><i aria-hidden="true" />{s.t}</li>)}
      </ol>
    </nav>
  );
}
