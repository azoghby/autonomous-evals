import type { CostEstimate as Estimate } from "@/lib/eval-chat/types";
import type { ActionState } from "../context";
import { clamp, usd } from "../format";
import { ActionFooter } from "./ActionFooter";

type Props = {
  estimate: Estimate;
  action: ActionState;
  confirmLabel: string;
  canConfirm?: boolean;
  blockedReason?: string | null;
};

/** Cost block (trials x per-trial = total against budget) plus the confirm/cancel footer. */
export function CostEstimate({ estimate, action, confirmLabel, canConfirm = true, blockedReason }: Props) {
  const over = estimate.totalUsd > estimate.budgetUsd;
  const ratio = estimate.budgetUsd > 0 ? clamp(estimate.totalUsd / estimate.budgetUsd, 0, 1) : 1;
  const blocked = !canConfirm || over;
  return (
    <div className="ec-cost">
      <dl className="ec-facts">
        <div><dt>Trials</dt><dd>{estimate.trials}</dd></div>
        <div><dt>Per trial</dt><dd>{usd(estimate.perTrialUsd)}</dd></div>
        <div><dt>Total</dt><dd data-tone={over ? "danger" : undefined}>{usd(estimate.totalUsd)}</dd></div>
      </dl>
      <div className="ec-bar" role="meter" aria-label="Estimated cost against budget" aria-valuemin={0} aria-valuemax={estimate.budgetUsd} aria-valuenow={Math.min(estimate.totalUsd, estimate.budgetUsd)} aria-valuetext={`${usd(estimate.totalUsd)} of ${usd(estimate.budgetUsd)} budget`} data-tone={over ? "danger" : "accent"}>
        <div className="ec-bar-fill" style={{ width: `${ratio * 100}%` }} />
      </div>
      <p className="ec-dim">{usd(estimate.totalUsd)} of {usd(estimate.budgetUsd)} budget. {estimate.basis}</p>
      <ActionFooter action={action} confirmLabel={confirmLabel} canConfirm={!blocked} blockedReason={over ? "This estimate is over the budget. Ask for fewer trials or a smaller scope." : blockedReason} />
    </div>
  );
}
