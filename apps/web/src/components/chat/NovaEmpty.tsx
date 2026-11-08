"use client";
import { IconClip, IconSpark } from "./icons";
import { NOVA, NovaAvatar } from "./NovaAvatar";

export type Suggestion = { label: string; kind: "send" | "attach"; text: string };

export const SUGGESTIONS: readonly Suggestion[] = [
  { label: "Test my support agent", kind: "send", text: "I want to test my customer support agent." },
  { label: "I have an OpenAPI spec", kind: "attach", text: "Here's the OpenAPI spec for my agent's tools." },
  { label: "Compare two models", kind: "send", text: "I'd like to compare two models on the same scenarios." },
];

const STEPS = [
  { n: "1", t: "Collect", d: "Your agent and its tools" },
  { n: "2", t: "Build", d: "A sandbox copy of your world" },
  { n: "3", t: "Run", d: "Simulated customers, k trials each" },
  { n: "4", t: "Report", d: "pass@1, pass^k, failure clusters" },
];

/** First screen: who Nova is, the four steps she runs, and three ways to start. */
export function NovaEmpty({ onPick, compact }: { onPick: (s: Suggestion) => void; compact?: boolean }) {
  return (
    <section className="nv-empty nv-enter" aria-labelledby="nv-empty-h">
      <div className="nv-empty-id">
        <NovaAvatar size={compact ? 40 : 52} />
        <div>
          <b id="nv-empty-h">{NOVA.name}</b>
          <span>{NOVA.role}</span>
        </div>
      </div>
      <p className="nv-empty-lead">{NOVA.bio} Tell me about the agent you want to test.</p>
      <ol className="nv-empty-steps" aria-label="What happens">
        {STEPS.map((s) => <li key={s.n}><span className="nv-label">{s.n} {s.t}</span><p>{s.d}</p></li>)}
      </ol>
      <div className="nv-suggest" role="group" aria-label="Ways to start">
        {SUGGESTIONS.map((s) => (
          <button key={s.label} type="button" className="nv-chip" onClick={() => onPick(s)}>
            {s.kind === "attach" ? <IconClip width={14} height={14} /> : <IconSpark />}
            {s.label}
          </button>
        ))}
      </div>
    </section>
  );
}
