import { STEP_IDS, type StepId } from "./replay";

const LABEL: Record<StepId, string> = {
  build: "Build world",
  branch: "Branch DB",
  simulate: "Simulate user",
  agent: "Agent acts",
  grade: "Grade state",
  verdict: "Verdict",
};

/** Slim six-step rail: finished steps are white, the active one is blue, upcoming ones are dim. */
export function StepRail({ stepIndex, progress }: { stepIndex: number; progress: number }) {
  return (
    <div>
      <ol className="grid grid-cols-6 gap-1.5 sm:gap-3" aria-label="Evaluation stages">
        {STEP_IDS.map((id, i) => {
          const state = i < stepIndex ? "done" : i === stepIndex ? "active" : "todo";
          return (
            <li key={id} aria-current={state === "active" ? "step" : undefined} className="min-w-0">
              <div className={`h-px transition-colors duration-300 ${state === "active" ? "bg-accent" : state === "done" ? "bg-fg-2" : "bg-line-2"}`} />
              <div
                className={`t-eyebrow mt-2 truncate text-[10px] transition-colors duration-300 sm:text-[12px] ${
                  state === "active" ? "text-accent-text" : state === "done" ? "text-fg-2" : "text-subtle"
                }`}
              >
                <span className="hidden sm:inline">{LABEL[id]}</span>
                <span className="sm:hidden">{i + 1}</span>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="t-eyebrow mt-2 text-accent-text sm:hidden">{LABEL[STEP_IDS[stepIndex]]}</p>
      <div className="mt-3 h-px w-full bg-line" aria-hidden>
        <div className="h-px origin-left bg-accent" style={{ transform: `scaleX(${progress})` }} />
      </div>
    </div>
  );
}
