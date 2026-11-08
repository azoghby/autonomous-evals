import type { CheckResult, ToolCallRecord, TrialResult } from "@ae/core/sandbox/spec";
import { Chip } from "@/components/ui";
import type { MediaPreview } from "../contract";
import { ATTRIBUTION_LABEL, SEVERITY_TONE, compactJson, findClause, isAgentFault } from "./format";
import { StateDiffTable } from "./StateDiffTable";

type Policies = Parameters<typeof findClause>[0];

const ROLE_STYLE: Record<string, string> = {
  user: "border-line-2 bg-bg-raised",
  assistant: "border-accent/30 bg-accent-soft",
  tool: "border-line-2 bg-bg font-mono text-[12px]",
};

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <h4 className="mb-2 font-mono text-[11px] uppercase text-subtle">{title}</h4>
      {children}
    </div>
  );
}

function ToolCall({ c }: { c: ToolCallRecord }) {
  const bad = Boolean(c.error || c.fault);
  return (
    <li className={`min-w-0 rounded-[4px] border p-3 ${bad ? "border-danger/50" : "border-line-2"}`}>
      <div className="flex flex-wrap items-center gap-2 font-mono text-[12px]">
        <span className="text-subtle tabular-nums">#{c.seq}</span>
        <span className="break-all text-fg">{c.tool}</span>
        {c.fault && <Chip tone="danger">fault: {c.fault}</Chip>}
        <span className="ml-auto text-subtle tabular-nums">{c.ms} ms</span>
      </div>
      <pre className="mt-2 max-w-full overflow-auto font-mono text-[12px] text-fg-2"><code>{compactJson(c.args)}</code></pre>
      <pre className="mt-1 max-w-full overflow-auto font-mono text-[12px] text-muted"><code>{"→ "}{compactJson(c.result)}</code></pre>
      {c.error && <p className="mt-1 break-words font-mono text-[12px] text-danger">Error: {c.error}</p>}
    </li>
  );
}

function Check({ c, policies }: { c: CheckResult; policies: Policies }) {
  const clause = findClause(policies, c.policyRef);
  return (
    <li className="min-w-0 border-b border-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={c.passed ? "ok" : "danger"} dot>{c.passed ? "pass" : "fail"}</Chip>
        <Chip tone={SEVERITY_TONE[c.severity]}>{c.severity}</Chip>
        <span className="font-mono text-[11px] uppercase text-subtle">{c.kind}</span>
        <span className="break-all font-mono text-[12px] text-fg-2">{c.id}</span>
      </div>
      <p className="mt-1 break-words text-[13px] text-fg-2">{c.detail}</p>
      {clause && <p className="mt-1 border-l-2 border-line-3 pl-3 text-[12px] text-muted"><span className="font-mono uppercase text-subtle">Policy {clause.id}</span> · {clause.text}</p>}
    </li>
  );
}

export function TrialDetail({ trial, media, policies }: { trial: TrialResult; media: MediaPreview[]; policies: Policies }) {
  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Chip tone={trial.passed ? "ok" : "danger"} dot>{trial.passed ? "Passed" : "Failed"}</Chip>
        <span className="font-mono text-[12px] text-subtle">variant {trial.variant}</span>
        {!trial.passed && trial.failureAttribution && (
          <>
            <Chip tone={isAgentFault(trial.failureAttribution) ? "neutral" : "muted"}>{ATTRIBUTION_LABEL[trial.failureAttribution]}</Chip>
            {!isAgentFault(trial.failureAttribution) && <span className="text-[12px] text-muted">Not counted against your agent</span>}
          </>
        )}
        {trial.error && <span className="break-words font-mono text-[12px] text-danger">{trial.error}</span>}
      </div>
      {media.length > 0 && (
        <Block title="Media">
          <ul className="flex flex-wrap gap-3">
            {media.map((m) => (
              <li key={m.attachmentId} className="max-w-full">
                {m.kind === "image" && /* eslint-disable-next-line @next/next/no-img-element */ <img src={m.src} alt={m.alt} className="max-h-64 max-w-full rounded-[4px] border border-line-2" />}
                {m.kind === "audio" && <audio controls src={m.src} aria-label={m.alt} className="max-w-full" />}
                {m.kind !== "image" && m.kind !== "audio" && <span className="text-[13px] text-muted">{m.kind}: {m.alt}</span>}
              </li>
            ))}
          </ul>
        </Block>
      )}
      <Block title="Transcript">
        <ol className="space-y-2">
          {trial.transcript.map((t, i) => (
            <li key={i} className={`min-w-0 rounded-[4px] border px-3 py-2 ${ROLE_STYLE[t.role] ?? ROLE_STYLE.user}`}>
              <span className="font-mono text-[11px] uppercase text-subtle">{t.role}</span>
              <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-fg-2">{t.content}</p>
            </li>
          ))}
        </ol>
      </Block>
      <Block title="Tool calls">
        {trial.toolCalls.length === 0 ? <p className="text-[13px] text-muted">No tool calls.</p> : <ol className="space-y-2">{trial.toolCalls.map((c) => <ToolCall key={c.seq} c={c} />)}</ol>}
      </Block>
      <Block title="State diff"><StateDiffTable diff={trial.diff} /></Block>
      <Block title="Checks"><ul>{trial.checks.map((c) => <Check key={c.id} c={c} policies={policies} />)}</ul></Block>
    </div>
  );
}
