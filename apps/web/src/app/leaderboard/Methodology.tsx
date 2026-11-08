import { Eyebrow, Frame } from "@/components/ui";
import { SUITE_VERSION } from "@/server/leaderboard";
import { suiteCounts } from "@/server/leaderboard-suite";

const CONTACT = process.env.LEADERBOARD_CONTACT_EMAIL;

export function Methodology() {
  const c = suiteCounts();
  return (
    <section id="methodology" aria-labelledby="method-h" className="mt-24 scroll-mt-20 border-t border-line-2 pt-12">
      <Eyebrow>Methodology</Eyebrow>
      <h2 id="method-h" className="t-h2 mt-4 max-w-3xl text-fg">How we score. <span className="text-muted">Same suite and same budget for every agent.</span></h2>
      <div className="mt-10 grid gap-px border border-line-2 bg-line-2 md:grid-cols-3">
        {[
          ["Suite", `${SUITE_VERSION}: ${c.total} frozen scenarios`, `${c.designed} designed scenarios (everyday tasks, instruction following, grounding) plus ${c.redTeam} tool-free red-team scenarios (prompt injection, jailbreaks, prompt extraction, data exfiltration, harmful requests, over-refusal). The suite is frozen: scores are only compared within one suite version.`],
          ["Scoring", "Deterministic checks", "A scenario passes only when every objective check passes. Red-team scenarios use code graders with canary strings, not an LLM opinion. Pass rate = scenarios passed / scenarios run. Red-team pass rate counts the red-team scenarios only."],
          ["Ranking", "Pass rate, then red-team, then criticals", "Ranked by overall pass rate, ties broken by red-team pass rate, then fewer critical findings. Each agent is shown with its most recent complete run. Open-source agents run their own system prompts and tools; only the model changes between their rows."],
        ].map(([k, h, body]) => (
          <div key={k} className="bg-bg p-6">
            <p className="font-mono text-[11px] uppercase text-subtle">{k}</p>
            <h3 className="t-h4 mt-3 text-fg">{h}</h3>
            <p className="mt-3 text-[14px] leading-[1.6] text-muted">{body}</p>
          </div>
        ))}
      </div>
      <Frame className="mt-10 max-w-3xl bg-bg-raised p-6">
        <h3 className="t-h4 text-fg">Authorization, re-tests and opt-out</h3>
        <ul className="mt-4 space-y-3 text-[14px] leading-[1.6] text-fg-2">
          <li>We only test agents we are allowed to test: each listed agent has a recorded terms page and authorization on file. Third-party agents are added only with permission.</li>
          <li>Findings show titles, severity and short excerpts, never full transcripts or secrets.</li>
          <li>
            To request a re-test (for example after a fix) or to be removed from the leaderboard, {CONTACT
              ? <>email <a className="text-accent-text underline underline-offset-4" href={`mailto:${CONTACT}`}>{CONTACT}</a></>
              : <>use the <a className="text-accent-text underline underline-offset-4" href="/start">Get an eval</a> form and mention the leaderboard</>}{" "}
            with the agent name. Opt-outs are honoured and results are hidden within one business day.
          </li>
        </ul>
      </Frame>
    </section>
  );
}
