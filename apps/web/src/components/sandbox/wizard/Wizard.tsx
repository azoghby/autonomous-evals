"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Spinner } from "@/components/ui";
import { SandboxIntakeInput, type SandboxDraft, type ScenarioReviewInput } from "../contract";
import { createDraft, reviewScenario, startRun, type ApiResult } from "./api";
import { buildRequest, initialForm, stepOfError, withExample, type WizardForm } from "./form";
import { ErrorList, type Errors } from "./controls";
import { ConnectStep } from "./ConnectStep";
import { WorldStep } from "./WorldStep";
import { ReviewStep } from "./ReviewStep";
import { RunStep } from "./RunStep";
import { STEPS, Stepper } from "./Stepper";

const SIGNIN = "/signin?next=/sandbox/new";
const HEADINGS = ["Connect your agent", "Describe its world", "Review the suite", "Run it"];

export function Wizard() {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<WizardForm>(initialForm);
  const [errors, setErrors] = useState<Errors>({});
  const [draft, setDraft] = useState<SandboxDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [k, setK] = useState(5);
  const [status, setStatus] = useState("");
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => { headingRef.current?.focus(); }, [step]);

  const patch = useCallback((p: Partial<WizardForm>) => { setForm((f) => ({ ...f, ...p })); setErrors({}); }, []);

  /** Returns true when the result was handled (auth redirect or error shown). */
  const failed = <T,>(r: ApiResult<T>): r is Extract<ApiResult<T>, { ok: false }> => {
    if (r.ok) return false;
    if (r.status === 401) { router.replace(SIGNIN); return true; }
    setFatal(r.error);
    setStatus(r.error);
    return true;
  };

  const validate = (target: 0 | 1): boolean => {
    const parsed = SandboxIntakeInput.safeParse(buildRequest(form));
    const errs: Errors = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".");
        if (stepOfError(key) === target && !(key in errs)) errs[key] = issue.message;
      }
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) { setStatus("Fix the highlighted fields to continue."); return false; }
    return true;
  };

  const next = () => { setFatal(null); if (validate(step as 0 | 1)) { setStatus(""); setStep(step + 1); } };
  const back = () => { setFatal(null); setErrors({}); setStep(step - 1); };

  const generate = async () => {
    setFatal(null);
    if (!validate(1)) return;
    if (!validate(0)) { setStep(0); return; }
    setGenerating(true); setStatus("Generating the scenario suite…");
    const r = await createDraft(buildRequest(form));
    setGenerating(false);
    if (failed(r)) {
      if (!r.ok && r.status === 422 && r.field) {
        const key = r.field.startsWith("integration") ? r.field : `integration.${r.field}`;
        setErrors({ [key]: r.error }); setStep(0);
      } else if (!r.ok && r.status === 400 && r.issues?.length) {
        const errs: Errors = {};
        for (const i of r.issues) errs[i.path.join(".")] = i.message;
        setErrors(errs); setStep(Object.keys(errs).some((e) => stepOfError(e) === 0) ? 0 : 1);
      }
      return;
    }
    setDraft(r.data.draft); setStatus("Suite ready. Review the scenarios."); setStep(2);
  };

  const review = async (scenarioId: string, input: ScenarioReviewInput) => {
    if (!draft) return;
    setFatal(null); setBusyId(scenarioId);
    const r = await reviewScenario(draft.draftId, scenarioId, input);
    setBusyId(null);
    if (failed(r)) return;
    setDraft(r.data.draft); setStatus("Scenario updated.");
  };

  const acceptAll = async () => {
    if (!draft) return;
    setFatal(null); setBusyId("*");
    let current = draft;
    for (const s of draft.scenarios.filter((x) => x.decision !== "accepted")) {
      const r = await reviewScenario(draft.draftId, s.scenario.id, { decision: "accepted" });
      if (failed(r)) { setBusyId(null); setDraft(current); return; }
      current = r.data.draft;
    }
    setBusyId(null); setDraft(current); setStatus("All scenarios accepted.");
  };

  const start = async () => {
    if (!draft) return;
    setFatal(null); setStarting(true); setStatus("Starting run…");
    const r = await startRun(draft.draftId, k);
    if (failed(r)) {
      setStarting(false);
      if (!r.ok && r.status === 409) setFatal("Nothing is accepted yet. Accept at least one scenario.");
      return;
    }
    router.push(`/sandbox/runs/${r.data.runId}`);
  };

  const accepted = draft?.scenarios.some((s) => s.decision === "accepted") ?? false;

  return (
    <div className="space-y-8">
      <Stepper current={step} />
      <div role="status" aria-live="polite" className="sr-only">{status}</div>
      <section aria-labelledby="wizard-heading" className="space-y-6">
        <h2 id="wizard-heading" ref={headingRef} tabIndex={-1} className="t-h3 text-fg outline-none">
          <span className="text-subtle">{step + 1}/{STEPS.length}</span> {HEADINGS[step]}
        </h2>
        {step === 0 && <ConnectStep form={form} set={patch} errors={errors} />}
        {step === 1 && <WorldStep form={form} set={patch} errors={errors} onExample={() => { setForm(withExample); setErrors({}); setStatus("Example loaded."); }} />}
        {step === 2 && draft && <ReviewStep draft={draft} busyId={busyId} onReview={review} onAcceptAll={acceptAll} />}
        {step === 3 && draft && <RunStep draft={draft} k={k} onK={setK} starting={starting} onStart={start} />}
        <ErrorList errors={step < 2 ? errors : {}} />
        {fatal && <p role="alert" className="border border-danger/40 px-4 py-3 text-sm text-danger break-words">{fatal}</p>}
      </section>
      <div className="flex flex-wrap items-center gap-3 border-t border-line-2 pt-6">
        {step > 0 && <Button variant="outline" onClick={back} disabled={generating || starting}>Back</Button>}
        {step < 1 && <Button onClick={next}>Continue</Button>}
        {step === 1 && <Button onClick={generate} disabled={generating}>{generating ? "Generating…" : "Generate suite"}</Button>}
        {step === 2 && <Button onClick={() => { setStatus(""); setStep(3); }} disabled={!accepted || busyId !== null}>Continue to run</Button>}
        {generating && <span className="inline-flex items-center gap-2 text-sm text-muted"><Spinner /> Building your sandbox world…</span>}
      </div>
    </div>
  );
}
