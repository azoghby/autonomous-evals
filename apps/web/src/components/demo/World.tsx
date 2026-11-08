"use client";

import { Chip } from "@/components/ui";
import type { DemoCheck, DemoDiff, DemoTrial } from "./demo-run-types";
import { cell, isRecord, str } from "./format";

const CHANGE_STYLE: Record<string, { sign: string; cls: string; flash: string }> = {
  insert: { sign: "+", cls: "text-ok", flash: "rgb(61 214 140 / 0.18)" },
  update: { sign: "~", cls: "text-warn", flash: "rgb(245 184 75 / 0.18)" },
  delete: { sign: "−", cls: "text-danger", flash: "rgb(255 107 94 / 0.18)" },
};
/** Judge rubric items are diagnostic unless flagged reward-bearing (mirrors engine isRewardBearing defaults). */
const isAdvisory = (c: DemoCheck) => c.kind === "rubric" && str(c.id).startsWith("rubric:");
const CHANGE_ALIAS: Record<string, string> = { inserted: "insert", updated: "update", deleted: "delete" };
const FALLBACK_STYLE ={ sign: "·", cls: "text-muted", flash: "rgb(42 95 255 / 0.18)" };

function Pairs({ value, tone }: { value: unknown; tone?: string }) {
  if (!isRecord(value)) return <span className={`break-words ${tone ?? ""}`}>{cell(value)}</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {Object.entries(value).map(([k, v]) => (
        <span key={k} className="break-all">
          <span className="text-subtle">{k}=</span>
          <span className={tone}>{cell(v)}</span>
        </span>
      ))}
    </span>
  );
}

/** Update rows show only keys that changed: key  before -> after. */
function UpdateBody({ before, after }: { before: unknown; after: unknown }) {
  if (!isRecord(before) || !isRecord(after)) {
    return (
      <span className="break-all">
        <span className="text-muted">{cell(before)}</span> <span className="text-subtle">→</span> <span className="text-fg">{cell(after)}</span>
      </span>
    );
  }
  const keys = Object.keys(after).filter((k) => cell(before[k]) !== cell(after[k]));
  if (keys.length === 0) return <span className="text-subtle">no visible field change</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {keys.map((k) => (
        <span key={k} className="break-all">
          <span className="text-subtle">{k} </span>
          <span className="text-muted line-through decoration-line-3">{cell(before[k])}</span>
          <span className="text-subtle"> → </span>
          <span className="text-fg">{cell(after[k])}</span>
        </span>
      ))}
    </span>
  );
}

function DiffRow({ row }: { row: unknown }) {
  const r = isRecord(row) ? row : { change: "unknown", after: row };
  const raw = str(r.change);
  // Runtime emits "inserted"/"updated"/"deleted"; accept the short forms too.
  const kind = CHANGE_ALIAS[raw] ?? raw;
  const st = CHANGE_STYLE[kind] ?? FALLBACK_STYLE;
  return (
    <li className="demo-flash relative flex gap-2.5 border-t border-line px-3 py-2" style={{ "--flash": st.flash } as React.CSSProperties}>
      <span aria-label={kind || "change"} className={`t-data w-3 shrink-0 ${st.cls}`}>{st.sign}</span>
      <div className="t-data min-w-0 flex-1">
        {kind !== "insert" && r.pk !== undefined && r.pk !== null ? <div className="mb-0.5 text-subtle">pk <Pairs value={r.pk} /></div> : null}
        {kind === "update" ? <UpdateBody before={r.before} after={r.after} /> : <Pairs value={kind === "delete" ? r.before : r.after} tone="text-fg-2" />}
      </div>
    </li>
  );
}

/** Outbox rows carry the tool args + runtime payload; show an email as to / subject / body, anything else as pairs. */
function OutboxItem({ m }: { m: unknown }) {
  const rec = isRecord(m) ? m : {};
  const src = [rec.payload, rec.args, rec].find((x) => isRecord(x) && ("to" in x || "subject" in x)) as Record<string, unknown> | undefined;
  if (!src) return <Pairs value={m} tone="text-fg-2" />;
  const payload = isRecord(rec.payload) ? rec.payload : {};
  const status = str(payload.status ?? (isRecord(payload.result) ? payload.result.status : undefined));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="break-all"><span className="text-subtle">to </span><span className="text-fg">{cell(src.to)}</span></span>
        {status ? <Chip tone={status === "rejected" ? "danger" : "muted"}>{status}</Chip> : null}
      </div>
      {src.subject !== undefined ? <div className="text-fg">{cell(src.subject)}</div> : null}
      {src.body !== undefined ? <p className="font-sans text-[13px] leading-[1.45] text-muted">{cell(src.body)}</p> : null}
    </div>
  );
}

function Counts({ d }: { d: DemoDiff }) {
  return (
    <span className="t-data flex gap-2 text-subtle">
      {d.inserted ? <span className="text-ok">+{d.inserted}</span> : null}
      {d.updated ? <span className="text-warn">~{d.updated}</span> : null}
      {d.deleted ? <span className="text-danger">−{d.deleted}</span> : null}
    </span>
  );
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="border-b border-line last:border-b-0">
      <header className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
        <h3 className="t-eyebrow text-muted">{title}</h3>
        {aside}
      </header>
      <div className="pb-4">{children}</div>
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="px-4 text-[13px] text-subtle">{children}</p>;

export function World({
  trial,
  diffRevealed,
  outboxRevealed,
  checksShown,
  graded,
}: {
  trial: DemoTrial;
  diffRevealed: boolean;
  outboxRevealed: boolean;
  checksShown: number;
  /** Grading has started (checks section is live). */
  graded: boolean;
}) {
  const diff = Array.isArray(trial.diff) ? trial.diff : [];
  const outbox = Array.isArray(trial.outbox) ? trial.outbox : [];
  const checks: DemoCheck[] = Array.isArray(trial.checks) ? trial.checks : [];

  return (
    <div>
      <Section title="Database changes" aside={<span className="t-eyebrow text-subtle">Neon branch</span>}>
        {!diffRevealed ? (
          <Empty>Branch is untouched. Rows appear here as the agent writes.</Empty>
        ) : diff.length === 0 ? (
          <Empty>No rows changed in this run.</Empty>
        ) : (
          <div className="flex flex-col gap-3 px-4">
            {diff.map((d, i) => (
              <div key={`${str(d.table)}-${i}`} className="demo-in overflow-hidden rounded-[2px] border border-line-2 bg-bg-band">
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="t-data break-all text-fg">{str(d.table) || "(table)"}</span>
                  <Counts d={d} />
                </div>
                <ul>
                  {(Array.isArray(d.sample) ? d.sample : []).map((row, j) => <DiffRow key={j} row={row} />)}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Outbox">
        {!outboxRevealed ? (
          <Empty>Nothing sent yet.</Empty>
        ) : outbox.length === 0 ? (
          <Empty>No emails sent.</Empty>
        ) : (
          <ul className="flex flex-col gap-2 px-4">
            {outbox.map((m, i) => (
              <li key={i} className="demo-in t-data min-w-0 rounded-[2px] border border-line-2 bg-bg-band px-3 py-2 break-words [overflow-wrap:anywhere]">
                <OutboxItem m={m} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Grader checks" aside={graded ? <span className="t-data text-subtle">{Math.min(checksShown, checks.length)}/{checks.length}</span> : null}>
        {!graded ? (
          <Empty>Grading runs after the conversation, on the final database state.</Empty>
        ) : checks.length === 0 ? (
          <Empty>No checks recorded.</Empty>
        ) : (
          <ul className="flex flex-col px-4">
            {checks.slice(0, checksShown).map((c) => {
              const advisory = isAdvisory(c);
              const tone = c.passed ? "text-ok" : advisory ? "text-subtle" : "text-danger";
              return (
              <li key={str(c.id)} className="demo-in flex items-start gap-2.5 border-t border-line py-2 first:border-t-0">
                <span aria-hidden className={`t-data mt-px w-3 shrink-0 ${tone}`}>{c.passed ? "✓" : advisory ? "–" : "✕"}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="sr-only">{c.passed ? "Passed:" : advisory ? "Advisory, not scored:" : "Failed:"}</span>
                    <span className="t-data break-all text-fg">{str(c.id)}</span>
                    <Chip tone="muted">{str(c.kind)}</Chip>
                    {!c.passed && advisory ? <Chip tone="muted">advisory · not scored</Chip> : null}
                    {!c.passed && !advisory ? <Chip tone="danger">{str(c.severity)}</Chip> : null}
                    {c.policyRef ? <span className="t-data text-subtle">§{str(c.policyRef)}</span> : null}
                  </div>
                  <p className="mt-1 break-words text-[13px] leading-[1.45] text-muted [overflow-wrap:anywhere]">{str(c.detail)}</p>
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
