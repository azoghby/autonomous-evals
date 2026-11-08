"use client";
import { useId, useState } from "react";
import { PLANS, formatUsd, type PlanId } from "@ae/core/pricing/plans";
import { ROI_BOUNDS, ROI_DEFAULTS, calculateRoi, type RoiInputs } from "@ae/core/pricing/roi";
import { Button, NudgeArrow } from "@/components/ui";
import { CheckoutButton } from "./CheckoutButton";

type FieldKey = keyof RoiInputs;
interface FieldDef {
  key: FieldKey;
  label: string;
  hint: string;
  prefix?: string;
  suffix?: string;
  step: number;
  /** Slider upper bound; the number field still accepts up to ROI_BOUNDS max. */
  sliderMax: number;
}

const GROUPS: readonly { title: string; fields: readonly FieldDef[] }[] = [
  {
    title: "What failure costs you today",
    fields: [
      { key: "agentConversationsPerMonth", label: "Agent conversations / month", hint: "Everything your agent handles.", step: 500, sliderMax: 200_000 },
      { key: "failureRatePct", label: "Conversations where it goes wrong", hint: "Your best estimate, as a percentage.", suffix: "%", step: 0.1, sliderMax: 25 },
      { key: "costPerFailureUsd", label: "Cost of one failure", hint: "Refund, churn, escalation, support time.", prefix: "$", step: 5, sliderMax: 2_000 },
    ],
  },
  {
    title: "What you assume testing fixes",
    fields: [
      { key: "expectedReductionPct", label: "Failure cost you remove", hint: "Assumption. Depends on what you fix.", suffix: "%", step: 1, sliderMax: 100 },
    ],
  },
  {
    title: "How much you would test",
    fields: [
      { key: "scenariosToTest", label: "Scenarios per release", hint: "Distinct situations to simulate.", step: 5, sliderMax: 500 },
      { key: "k", label: "Trials per scenario (k)", hint: "Repeats, so one lucky pass does not count.", step: 1, sliderMax: 20 },
      { key: "releasesPerMonth", label: "Releases / month", hint: "Prompt, model or tool changes you test.", step: 1, sliderMax: 30 },
    ],
  },
];

const PLAN_LINE: Record<PlanId, string> = {
  developer: "Free, no card",
  pro: "per month, billed monthly",
  scale: "per month, billed monthly",
  enterprise: "Volume pricing",
};

const whole = (cents: number): string => formatUsd(Math.round(cents / 100) * 100);
const fmt = (n: number): string => n.toLocaleString("en-US");

function Field({ def, raw, clamped, onChange }: { def: FieldDef; raw: string; clamped: number; onChange: (v: string) => void }) {
  const id = useId();
  const { min, max } = ROI_BOUNDS[def.key];
  const sliderValue = Math.min(clamped, def.sliderMax);
  return (
    <div className="roi-field">
      <label htmlFor={id} className="roi-label">{def.label}</label>
      <div className="roi-row">
        <div className="roi-input-wrap">
          {def.prefix && <span aria-hidden className="roi-affix">{def.prefix}</span>}
          <input
            id={id} className="roi-input" type="number" inputMode="decimal" min={min} max={max} step={def.step}
            value={raw} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-hint`}
          />
          {def.suffix && <span aria-hidden className="roi-affix">{def.suffix}</span>}
        </div>
        <input
          className="roi-range" type="range" min={min} max={def.sliderMax} step={def.step} value={sliderValue}
          onChange={(e) => onChange(e.target.value)} aria-label={`${def.label} slider`}
          style={{ ["--roi-fill" as string]: `${((sliderValue - min) / (def.sliderMax - min)) * 100}%` }}
        />
      </div>
      <p id={`${id}-hint`} className="roi-hint">{def.hint}</p>
    </div>
  );
}

function PlanCta({ plan }: { plan: PlanId }) {
  if (plan === "pro" || plan === "scale") {
    return <CheckoutButton request={{ kind: "plan", plan, interval: "month" }} size="lg" className="w-full">Start {PLANS[plan].name}</CheckoutButton>;
  }
  const href = plan === "developer" ? "/sandbox" : "/contact-sales";
  return <Button href={href} size="lg" className="w-full">{plan === "developer" ? "Start free" : "Talk to us"} <NudgeArrow /></Button>;
}

/** Cost-of-failure calculator. Everything shown is derived from the visitor's own assumptions. */
export function RoiCalculator() {
  const [raw, setRaw] = useState<Record<FieldKey, string>>(
    () => Object.fromEntries((Object.keys(ROI_DEFAULTS) as FieldKey[]).map((k) => [k, String(ROI_DEFAULTS[k])])) as Record<FieldKey, string>,
  );
  const r = calculateRoi(raw);
  const plan = PLANS[r.recommendedPlan];
  const net = r.netMonthlyValueCents;

  return (
    <div className="roi">
      <div className="roi-inputs">
        {GROUPS.map((g) => (
          <fieldset key={g.title} className="roi-group">
            <legend className="roi-legend">{g.title}</legend>
            {g.fields.map((f) => (
              <Field key={f.key} def={f} raw={raw[f.key]} clamped={r.inputs[f.key]} onChange={(v) => setRaw((s) => ({ ...s, [f.key]: v }))} />
            ))}
          </fieldset>
        ))}
        <button type="button" className="roi-reset" onClick={() => setRaw(Object.fromEntries((Object.keys(ROI_DEFAULTS) as FieldKey[]).map((k) => [k, String(ROI_DEFAULTS[k])])) as Record<FieldKey, string>)}>
          Reset to example values
        </button>
      </div>

      <div className="roi-out" aria-live="polite" aria-atomic="false">
        <div className="roi-hero">
          <p className="roi-kicker">Avoidable failure cost / month</p>
          <p className="roi-big" data-zero={r.avoidableCostCents === 0}>{whole(r.avoidableCostCents)}</p>
          <p className="roi-why">
            {whole(r.monthlyFailureCostCents)} a month in failures, of which you assume {r.inputs.expectedReductionPct}% is avoidable.
          </p>
        </div>

        <dl className="roi-stats">
          <div><dt>Trials you would run</dt><dd>{fmt(r.trialsNeededPerMonth)}<span> / mo</span></dd><p>{r.rationale.trials}</p></div>
          <div>
            <dt>Net after plan cost</dt>
            <dd data-neg={net != null && net < 0}>{net == null ? "Custom" : `${net < 0 ? "-" : ""}${whole(Math.abs(net))}`}</dd>
            <p>{r.paybackDays != null ? r.rationale.payback : r.rationale.roi}</p>
          </div>
          <div>
            <dt>Return on plan</dt>
            <dd>{r.roiMultiple != null ? `${r.roiMultiple}x` : "n/a"}</dd>
            <p>{r.rationale.roi}</p>
          </div>
        </dl>

        <div className="roi-plan" data-plan={r.recommendedPlan}>
          <p className="roi-kicker">Fits your testing volume</p>
          <div className="roi-plan-head">
            <h3 className="roi-plan-name">{plan.name}</h3>
            <p className="roi-plan-price">
              {r.planMonthlyCostCents == null ? "Custom" : formatUsd(r.planMonthlyCostCents)}
              <span> {PLAN_LINE[r.recommendedPlan]}</span>
            </p>
          </div>
          <p className="roi-plan-why">{r.rationale.plan}</p>
          <PlanCta plan={r.recommendedPlan} />
        </div>

        <p className="roi-disclaimer">
          Illustrative estimate from your own assumptions — not a guarantee. Reduction depends on what you fix.
        </p>
      </div>
    </div>
  );
}
