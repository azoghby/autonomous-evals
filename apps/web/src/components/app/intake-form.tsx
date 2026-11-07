"use client";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IntakeInput, MAX_TRACE_BYTES, PACKAGES, PRICE_CENTS, type Package } from "@ae/core/contracts/index";
import { api, ApiError, dollars, errMsg, PACKAGE_LABEL } from "@/lib/client/api";
import { Btn, cx, ErrorBox, Field, Glass, PageTitle, Textarea } from "./ui";
import { EndpointFields, emptyEndpoint, endpointPayload, type EndpointDraft } from "./endpoint-fields";

const BLURB: Record<Package, string> = {
  trace_audit: "Paste or upload an agent transcript or tool log. We check every claim against the evidence.",
  text_eval: "12 scenarios against your OpenAI-compatible endpoint, with code checks and labeled rubric judges.",
  workflow_eval: "Your tool-calling agent runs in our calendar simulator, graded on resulting state.",
  version_comparison: "Same frozen suite against two configs. Observed differences only.",
};

function issuesToErrors(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const path = i.path.map(String);
    const key = path[path.length - 1] ?? "form";
    const scoped = path.length > 1 ? `${path[0]}.${key}` : key;
    out[scoped] ??= i.message;
  }
  return out;
}
const sub = (errs: Record<string, string>, prefix: string) =>
  Object.fromEntries(Object.entries(errs).filter(([k]) => k.startsWith(prefix + ".")).map(([k, v]) => [k.slice(prefix.length + 1), v]));

export function IntakeForm() {
  const router = useRouter();
  const idemKey = useRef<string>(crypto.randomUUID());
  const [pkg, setPkg] = useState<Package | null>(null);
  const [trace, setTrace] = useState("");
  const [traceErr, setTraceErr] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [notes, setNotes] = useState("");
  const [endpoint, setEndpoint] = useState<EndpointDraft>(emptyEndpoint);
  const [endpointA, setEndpointA] = useState<EndpointDraft>(emptyEndpoint);
  const [endpointB, setEndpointB] = useState<EndpointDraft>(emptyEndpoint);
  const [mode, setMode] = useState<"text" | "workflow">("text");
  const [authorized, setAuthorized] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(file: File | undefined) {
    setTraceErr(null);
    if (!file) return;
    if (!/\.(json|txt)$/i.test(file.name)) { setTraceErr("Only .json or .txt files are supported."); return; }
    if (file.size > MAX_TRACE_BYTES) { setTraceErr(`File is ${(file.size / 1024).toFixed(0)} KB. The limit is ${MAX_TRACE_BYTES / 1024} KB.`); return; }
    setTrace(await file.text());
  }

  const traceBytes = useMemo(() => new Blob([trace]).size, [trace]);

  function build(): unknown {
    const common = { authorizedToTest: authorized, ...(notes.trim() ? { notes } : {}) };
    switch (pkg) {
      case "trace_audit":
        return { package: pkg, trace, ...(systemPrompt.trim() ? { systemPrompt } : {}), ...common };
      case "text_eval":
      case "workflow_eval":
        return { package: pkg, endpoint: endpointPayload(endpoint), ...common };
      case "version_comparison":
        return { package: pkg, mode, endpointA: endpointPayload(endpointA), endpointB: endpointPayload(endpointB), ...common };
      default:
        return {};
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!pkg) return;
    if (pkg === "trace_audit" && traceBytes > MAX_TRACE_BYTES) {
      setErrors({ trace: `Trace is ${(traceBytes / 1024).toFixed(0)} KB; the limit is ${MAX_TRACE_BYTES / 1024} KB.` });
      return;
    }
    const parsed = IntakeInput.safeParse(build());
    if (!parsed.success) {
      const errs = issuesToErrors(parsed.error.issues);
      if (errs.authorizedToTest) errs.authorizedToTest = "You must confirm you are authorized to test this system.";
      setErrors(errs);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const r = await api<{ jobId: string }>("/api/jobs", {
        method: "POST", json: parsed.data, headers: { "Idempotency-Key": idemKey.current },
      });
      router.push(`/jobs/${r.jobId}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { router.push("/signin?next=/start"); return; }
      setSubmitError(errMsg(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-8">
      <PageTitle title="New request" sub="Pilot pricing. Pick a package, tell us what to test, and an agent will quote you from the fixed price table." />

      <fieldset>
        <legend className="mb-3 text-sm font-semibold">1. Package</legend>
        <div role="radiogroup" className="grid gap-3 sm:grid-cols-2">
          {PACKAGES.map((p) => (
            <button type="button" key={p} role="radio" aria-checked={pkg === p} onClick={() => { setPkg(p); setErrors({}); }}
              className={cx("rounded-[18px] border p-5 text-left backdrop-blur-xl transition duration-150 focus-visible:outline-2 focus-visible:outline-cream",
                pkg === p ? "border-coral bg-coral/15 shadow-[0_0_0_1px_var(--coral)]" : "border-glass-border bg-glass hover:bg-glass-strong")}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-lg font-semibold">{PACKAGE_LABEL[p]}</span>
                <span className="text-xl font-semibold tabular-nums text-coral">{dollars(PRICE_CENTS[p])}</span>
              </div>
              <p className="mt-2 text-sm text-cream/70">{BLURB[p]}</p>
            </button>
          ))}
        </div>
      </fieldset>

      {pkg && (
        <Glass className="space-y-6">
          <h2 className="text-sm font-semibold">2. {PACKAGE_LABEL[pkg]} details</h2>

          {pkg === "trace_audit" && (
            <div className="space-y-4">
              <Field label="Transcript or tool log" hint={`JSON or text, up to ${MAX_TRACE_BYTES / 1024} KB. Currently ${(traceBytes / 1024).toFixed(1)} KB.`} error={errors.trace ?? traceErr ?? undefined}>
                <Textarea className="min-h-56 font-mono text-xs" value={trace} onChange={(e) => setTrace(e.target.value)} placeholder="Paste your agent's transcript or tool log here" />
              </Field>
              <Field label="Or upload a file" hint=".json or .txt, read in your browser">
                <input type="file" accept=".json,.txt,application/json,text/plain" onChange={(e) => void onFile(e.target.files?.[0])}
                  className="block w-full text-sm file:mr-3 file:rounded-full file:border-0 file:bg-glass-strong file:px-4 file:py-2 file:text-cream hover:file:bg-glass-strong/80" />
              </Field>
              <Field label="System prompt (optional)" hint="Lets us flag instruction violations." error={errors.systemPrompt}>
                <Textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
              </Field>
            </div>
          )}

          {(pkg === "text_eval" || pkg === "workflow_eval") && (
            <EndpointFields value={endpoint} onChange={setEndpoint} errors={sub(errors, "endpoint")} />
          )}

          {pkg === "version_comparison" && (
            <div className="space-y-6">
              <Field label="Evaluation mode">
                <div className="flex gap-2" role="radiogroup">
                  {(["text", "workflow"] as const).map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                      className={cx("rounded-full border px-4 py-1.5 text-sm", mode === m ? "border-coral bg-coral/15" : "border-glass-border bg-glass")}>
                      {m === "text" ? "Text Eval" : "Workflow Eval"}
                    </button>
                  ))}
                </div>
              </Field>
              <EndpointFields legend="Version A" value={endpointA} onChange={setEndpointA} errors={sub(errors, "endpointA")} />
              <EndpointFields legend="Version B" value={endpointB} onChange={setEndpointB} errors={sub(errors, "endpointB")} />
            </div>
          )}

          <Field label="Notes (optional)" error={errors.notes}>
            <Textarea className="min-h-20" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>

          <div>
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#ff6b5b]" />
              <span>I&apos;m authorized to test this system.</span>
            </label>
            {errors.authorizedToTest && <p role="alert" className="mt-1 text-xs text-coral">{errors.authorizedToTest}</p>}
          </div>

          {Object.keys(errors).length > 0 && <p role="alert" className="text-sm text-coral">Please fix the highlighted fields.</p>}
          {submitError && <ErrorBox message={submitError} />}
          <Btn type="submit" loading={busy}>Submit request · {dollars(PRICE_CENTS[pkg])}</Btn>
          <p className="text-xs text-cream/60">You will not be charged until you accept a quote.</p>
        </Glass>
      )}
    </form>
  );
}
