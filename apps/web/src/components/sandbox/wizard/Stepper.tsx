export const STEPS = ["Connect", "World", "Review", "Run"] as const;

export function Stepper({ current }: { current: number }) {
  return (
    <nav aria-label="Progress">
      <ol className="grid grid-cols-4 gap-px border border-line-2 bg-line-2">
        {STEPS.map((label, i) => {
          const state = i === current ? "current" : i < current ? "done" : "todo";
          return (
            <li key={label} aria-current={state === "current" ? "step" : undefined} className={`min-w-0 bg-bg px-3 py-3 ${state === "current" ? "border-t-2 border-accent" : "border-t-2 border-transparent"}`}>
              <span className={`t-eyebrow block ${state === "todo" ? "text-subtle" : state === "done" ? "text-fg-2" : "text-accent-text"}`}>
                <span className="sr-only">Step </span>{i + 1}<span className="sr-only">{state === "done" ? " (complete)" : ""}</span>
              </span>
              <span className={`block truncate text-sm ${state === "current" ? "text-fg" : "text-muted"}`}>{label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
