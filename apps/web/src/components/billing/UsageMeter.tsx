interface UsageMeterProps {
  label: string;
  /** Pre-formatted used value, e.g. "1,200" or "$0.40". */
  used: string;
  /** Pre-formatted limit, or null for unlimited / custom. */
  limit: string | null;
  /** Used / limit as a ratio (may exceed 1). */
  ratio: number;
  note?: string;
}

/** Horizontal meter. Colour follows state: spectrum normally, warn from 80%, danger at 100%. */
export function UsageMeter({ label, used, limit, ratio, note }: UsageMeterProps) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const state = ratio >= 1 ? "full" : ratio >= 0.8 ? "near" : "ok";
  return (
    <div className="bill-meter" data-state={limit ? state : "open"}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[14px] text-fg-2">{label}</span>
        <span className="font-mono text-[14px] text-fg">
          {used}<span className="text-muted"> / {limit ?? "custom"}</span>
        </span>
      </div>
      {limit ? (
        <div className="bill-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className="bill-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {note ? <p className="mt-2 text-[13px] text-muted">{note}</p> : null}
    </div>
  );
}
