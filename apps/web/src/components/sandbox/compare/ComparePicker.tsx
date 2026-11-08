import { formatDate } from "../report/format";

export type PickerRun = { runId: string; name: string; createdAt: string; k: number; passHatK: number | null };

const label = (r: PickerRun) =>
  `${r.name} · ${formatDate(r.createdAt)} · k=${r.k}${r.passHatK !== null ? ` · pass^k ${Math.round(r.passHatK * 100)}%` : ""}`;

/** Plain GET form: works without JavaScript and keeps the comparison in the URL (shareable). */
export function ComparePicker({ runs, base, other }: { runs: PickerRun[]; base?: string; other?: string }) {
  return (
    <form method="get" action="/sandbox/compare" className="rc-picker" aria-label="Choose runs to compare">
      <label className="rc-pick">
        <span className="t-eyebrow text-muted">Base run</span>
        <select name="base" className="select" defaultValue={base} required>
          {runs.map((r) => <option key={r.runId} value={r.runId}>{label(r)}</option>)}
        </select>
      </label>
      <span className="rc-pick-vs" aria-hidden="true">vs</span>
      <label className="rc-pick">
        <span className="t-eyebrow text-muted">Compared run</span>
        <select name="other" className="select" defaultValue={other} required>
          {runs.map((r) => <option key={r.runId} value={r.runId}>{label(r)}</option>)}
        </select>
      </label>
      <button type="submit" className="rc-go">Compare</button>
    </form>
  );
}
