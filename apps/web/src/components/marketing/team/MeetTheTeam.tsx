import type { CSSProperties } from "react";
import { Eyebrow, Section } from "../../ui";
import { InViewGroup } from "../InViewGroup";
import { DEPARTMENTS, FOUNDER, ROSTER, STATUS_LABEL, type GlyphShape, type TeamAgent } from "./roster";

const SHAPES: Record<GlyphShape, string> = {
  hex: "M20 3 35 11.5v17L20 37 5 28.5v-17Z",
  diamond: "M20 2 38 20 20 38 2 20Z",
  ring: "M20 4a16 16 0 1 0 0 32 16 16 0 0 0 0-32Z",
  tri: "M20 3 37 35H3Z",
  square: "M6 6h28v28H6Z",
  notch: "M4 4h24l8 8v24H4Z",
};

function Glyph({ agent }: { agent: TeamAgent }) {
  const initial = agent.name.charAt(0);
  const hollow = agent.status === "coming";
  return (
    <svg className="tm-glyph" viewBox="0 0 40 40" width="44" height="44" aria-hidden="true" style={{ "--t": `var(--tone-${agent.tone})` } as CSSProperties}>
      <path d={SHAPES[agent.shape]} className={hollow ? "tm-shape tm-shape-hollow" : "tm-shape"} strokeLinejoin="round" />
      <text x="20" y={agent.shape === "tri" ? 27 : 25} textAnchor="middle" className="tm-initial">{initial}</text>
    </svg>
  );
}

function AgentCard({ agent, index }: { agent: TeamAgent; index: number }) {
  return (
    <li className={`tm-card${agent.featured ? " tm-featured" : ""}`} style={{ "--i": index, "--t": `var(--tone-${agent.tone})` } as CSSProperties}>
      <article className="tm-inner" aria-labelledby={`tm-${agent.id}`}>
        <header className="tm-head">
          <Glyph agent={agent} />
          <div className="min-w-0 flex-1">
            <h4 id={`tm-${agent.id}`} className="tm-name">{agent.name}</h4>
            <p className="tm-role">{agent.role}</p>
          </div>
          <span className={`tm-chip tm-chip-${agent.status}`}>
            <span aria-hidden="true" className="tm-dot" />
            {STATUS_LABEL[agent.status]}
          </span>
        </header>
        <p className="tm-bio">{agent.bio}</p>
        <dl className="tm-meta">
          <div><dt>Reports to</dt><dd>{agent.reportsTo}</dd></div>
          <div><dt>Can</dt><dd>{agent.can}</dd></div>
          <div><dt>Needs founder</dt><dd>{agent.needsApproval}</dd></div>
        </dl>
      </article>
    </li>
  );
}

/** Landing section: the AI agents that run the company, grouped by department. */
export function MeetTheTeam() {
  let counter = 0;
  return (
    <Section id="team" labelledBy="tm-h" className="scroll-mt-16">
      <div className="mb-14 flex max-w-[44rem] flex-col gap-6">
        <Eyebrow>Meet the team</Eyebrow>
        <h2 id="tm-h" className="t-h2 text-balance text-fg">Standard Evals is run by agents. <span className="text-muted">One human signs off.</span></h2>
        <p className="t-lead">Each one has a job, a boss, and a short list of things it is not allowed to do alone.</p>
      </div>
      <div className="flex flex-col gap-14">
        {DEPARTMENTS.map((d) => {
          const members = ROSTER.filter((a) => a.department === d.id);
          return (
            <InViewGroup key={d.id} className="tm-group" threshold={0.1}>
              <div className="tm-dept">
                <h3 className="tm-dept-label">{d.label}</h3>
                <p className="tm-dept-blurb">{d.blurb}</p>
              </div>
              <ul className="tm-grid">
                {members.map((a) => <AgentCard key={a.id} agent={a} index={counter++ % 6} />)}
              </ul>
            </InViewGroup>
          );
        })}
        <div className="tm-founder">
          <svg width="44" height="44" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="16" fill="none" stroke="var(--fg)" strokeWidth="1.5" strokeDasharray="3 4" /><path d="m13 20.5 5 5 9-10" fill="none" stroke="var(--fg)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <div>
            <p className="tm-role">{FOUNDER.tagline}</p>
            <h4 className="tm-name">{FOUNDER.title}</h4>
            <p className="tm-bio">{FOUNDER.body}</p>
          </div>
        </div>
      </div>
    </Section>
  );
}
