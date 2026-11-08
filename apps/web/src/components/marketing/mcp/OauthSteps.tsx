import { InViewGroup } from "../InViewGroup";

const STEPS = [
  { n: "01", t: "Add", d: "One command registers the server. No API key." },
  { n: "02", t: "Sign in", d: "Your browser opens. Sign in with an email magic link." },
  { n: "03", t: "Allow", d: "Approve “Allow Claude Code to use Standard Evals as you.”" },
  { n: "04", t: "13 tools", d: "Quotes, jobs, reports and sandbox evals. Ready." },
] as const;

/** OAuth flow strip. SSR is fully lit; when armed below the fold, steps and connectors light up in sequence (CSS, see globals.css mo-*). */
export function OauthSteps() {
  return (
    <InViewGroup className="mo-flow" threshold={0.3}>
      <ol className="mo-steps" aria-label="How the install works">
        {STEPS.map((s, i) => (
          <li key={s.n} className="mo-step" style={{ "--i": i } as React.CSSProperties}>
            <span aria-hidden className="mo-node">{s.n}</span>
            {i < STEPS.length - 1 && (
              <span aria-hidden className="mo-line"><i className="mo-line-fill" /></span>
            )}
            <div className="mo-copy">
              <p className="mo-title"><span className="sr-only">Step {i + 1}: </span>{s.t}</p>
              <p className="mo-desc">{s.d}</p>
            </div>
          </li>
        ))}
      </ol>
    </InViewGroup>
  );
}
