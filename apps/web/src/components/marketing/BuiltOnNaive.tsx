import { Eyebrow, Reveal, Section } from "../ui";

const ROLES: ReadonlyArray<{ name: string; job: string }> = [
  { name: "Commercial", job: "Qualifies a request and proposes a quote." },
  { name: "Evaluation engineer", job: "Designs suites and proposes fixes." },
  { name: "Quality investigator", job: "Audits traces and reports findings." },
  { name: "Company operator", job: "Drafts operational follow-ups." },
];

const GUARDS = ["Tools denied", "Strict output schemas", "Per-task budget reservation + settlement"];

function Arrow() {
  return (
    <span className="naive-arrow" aria-hidden="true">
      <svg width="20" height="12" viewBox="0 0 20 12" fill="none"><path d="M0 6h17m0 0-5-5m5 5-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  );
}

/** Short, status-honest note on how Standard Evals uses Naive managed agents. Static copy; see docs/NAIVE_PLAN.md. */
export function BuiltOnNaive() {
  return (
    <Section id="naive" labelledBy="naive-h" className="scroll-mt-16">
      <Reveal className="flex flex-col gap-5">
        <Eyebrow>Built on Naïve</Eyebrow>
        <h2 id="naive-h" className="t-h2 max-w-[30ch] text-balance text-fg">Agents propose. <span className="text-muted">Code decides money, access and pass/fail.</span></h2>
        <p className="t-lead max-w-[60ch]">Four version-pinned Naïve managed agents do the judgment work. Our code owns every dollar, permission and verdict.</p>
      </Reveal>
      <ol className="naive-row" aria-label="Naïve managed agents">
        {ROLES.map((r, i) => (
          <li key={r.name} className="naive-item">
            <div className="naive-card">
              <span className="naive-idx">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="naive-name">{r.name}</h3>
              <p className="naive-job">{r.job}</p>
            </div>
            {i < ROLES.length - 1 ? <Arrow /> : null}
          </li>
        ))}
      </ol>
      <ul className="naive-guards" aria-label="Guardrails">
        {GUARDS.map((g) => <li key={g}>{g}</li>)}
      </ul>
      <p className="naive-status">
        <span className="naive-dot" aria-hidden="true" />
        Status: production evals run on our lite engine today. On staging, Naïve runs qualify, trace audit and report end to end; the judge proxy is built and not yet live.
      </p>
    </Section>
  );
}
