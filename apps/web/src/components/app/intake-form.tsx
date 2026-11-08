"use client";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IntakeInput, MAX_TRACE_BYTES, PACKAGES, PRICE_CENTS, type Package } from "@ae/core/contracts/index";
import { api, ApiError, dollars, errMsg, PACKAGE_LABEL } from "@/lib/client/api";
import { AnimatePresence, motion } from "motion/react";
import { Button, Eyebrow, Field, Frame } from "@/components/ui";
import { Banner, cx, ErrorBox } from "./ui";
import { EASE } from "./motion";
import { PageHead } from "./page-parts";
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

  const submitDisabled = busy || !pkg;
  const stepLabel = "t-eyebrow mb-6 flex items-center gap-3 text-subtle";

  return (
    <form onSubmit={submit} noValidate>
      <PageHead eyebrow="Request · step 1 of 3" title="New request" lead="Quick evals. Pick a package, tell us what to test, and an agent will quote you from the fixed price table." />

      <div className="grid gap-x-12 gap-y-12 lg:grid-cols-12">
        <div className="min-w-0 space-y-14 lg:col-span-8">
          <fieldset>
            <legend className={stepLabel}><span className="text-accent-text">01</span><span>Package</span></legend>
            <div role="radiogroup" aria-label="Package" className="overflow-hidden rounded-[4px] border border-line-2 bg-bg-raised">
              {PACKAGES.map((p) => {
                const on = pkg === p;
                return (
                  <button key={p} type="button" role="radio" aria-checked={on} onClick={() => { setPkg(p); setErrors({}); }}
                    className={cx(
                      "relative grid w-full grid-cols-[16px_1fr_auto] items-start gap-x-4 border-b border-line px-5 py-4 text-left transition-colors duration-150 last:border-b-0 hover:bg-bg-hover focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                      on && "bg-bg-hover",
                    )}>
                    {on && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
                    <span aria-hidden className={cx("mt-[3px] flex size-4 items-center justify-center rounded-full border transition-colors", on ? "border-accent" : "border-line-3")}>
                      {on && <span className="size-2 rounded-full bg-accent" />}
                    </span>
                    <span className="min-w-0">
                      <span className={cx("block text-[16px] leading-6 tracking-[-0.01em]", on ? "text-fg" : "text-fg-2")}>{PACKAGE_LABEL[p]}</span>
                      <span className="mt-1 block max-w-[56ch] text-[13px] leading-[1.5] text-muted">{BLURB[p]}</span>
                    </span>
                    <span className="t-data mt-0.5 text-fg">{dollars(PRICE_CENTS[p])}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <AnimatePresence mode="wait" initial={false}>
            {pkg && (
              <motion.div key={pkg} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.24, ease: EASE }} className="space-y-14">
                <section aria-label={`${PACKAGE_LABEL[pkg]} details`}>
                  <h2 className={stepLabel}><span className="text-accent-text">02</span><span>{PACKAGE_LABEL[pkg]} details</span></h2>
                  <div className="space-y-6">
                    {pkg === "trace_audit" && (
                      <>
                        <Field id="trace" multiline rows={12} label="Transcript or tool log" hint={`JSON or text, up to ${MAX_TRACE_BYTES / 1024} KB. Currently ${(traceBytes / 1024).toFixed(1)} KB.`}
                          error={errors.trace ?? traceErr ?? undefined} value={trace} onChange={(e) => setTrace(e.target.value)} placeholder="Paste your agent's transcript or tool log here"
                          className="[&_textarea]:font-mono [&_textarea]:text-xs [&_textarea]:leading-relaxed" />
                        <div className="flex flex-col gap-1.5">
                          <label htmlFor="trace-file" className="text-[13px] leading-none text-fg-2">Or upload a file</label>
                          <input id="trace-file" type="file" accept=".json,.txt,application/json,text/plain" onChange={(e) => void onFile(e.target.files?.[0])}
                            className="input flex items-center py-0 text-[13px] text-muted file:mr-3 file:h-full file:cursor-pointer file:border-0 file:border-r file:border-line-2 file:bg-transparent file:pr-3 file:text-[13px] file:text-fg" />
                          <p className="text-xs text-subtle">.json or .txt, read in your browser</p>
                        </div>
                        <Field id="system-prompt" multiline rows={5} label="System prompt (optional)" hint="Lets us flag instruction violations." error={errors.systemPrompt}
                          value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
                      </>
                    )}

                    {(pkg === "text_eval" || pkg === "workflow_eval") && (
                      <EndpointFields value={endpoint} onChange={setEndpoint} errors={sub(errors, "endpoint")} />
                    )}

                    {pkg === "version_comparison" && (
                      <div className="space-y-10">
                        <div className="flex flex-col gap-1.5">
                          <span id="mode-label" className="text-[13px] leading-none text-fg-2">Evaluation mode</span>
                          <div role="radiogroup" aria-labelledby="mode-label" className="inline-grid w-full grid-cols-2 overflow-hidden rounded-[4px] border border-line-3 sm:w-80">
                            {(["text", "workflow"] as const).map((m) => (
                              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                                className={cx("h-10 border-r border-line-3 text-[15px] transition-colors duration-150 last:border-r-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                                  mode === m ? "bg-accent-soft text-fg shadow-[inset_0_-1px_0_var(--accent)]" : "text-muted hover:bg-bg-hover hover:text-fg")}>
                                {m === "text" ? "Text Eval" : "Workflow Eval"}
                              </button>
                            ))}
                          </div>
                        </div>
                        <EndpointFields legend="Version A" value={endpointA} onChange={setEndpointA} errors={sub(errors, "endpointA")} />
                        <EndpointFields legend="Version B" value={endpointB} onChange={setEndpointB} errors={sub(errors, "endpointB")} />
                      </div>
                    )}

                    <Field id="notes" multiline rows={3} label="Notes (optional)" error={errors.notes} value={notes} onChange={(e) => setNotes(e.target.value)} />
                  </div>
                </section>

                <section aria-label="Authorization">
                  <h2 className={stepLabel}><span className="text-accent-text">03</span><span>Authorize</span></h2>
                  <label className="flex cursor-pointer items-start gap-3 rounded-[4px] border border-line-2 bg-bg-raised p-4 text-[15px] text-fg-2 transition-colors hover:border-line-3 has-[:checked]:border-accent/60 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
                    <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} className="mt-[3px] size-4 shrink-0 accent-accent" />
                    <span>I&apos;m authorized to test this system.</span>
                  </label>
                  {errors.authorizedToTest && <p role="alert" className="mt-2 text-xs text-danger">{errors.authorizedToTest}</p>}
                </section>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <aside className="self-start lg:sticky lg:top-24 lg:col-span-4" aria-label="Summary">
          <Frame className="p-5">
            <Eyebrow tone="muted">Summary</Eyebrow>
            {pkg ? (
              <>
                <p className="t-h3 mt-5 text-fg">{PACKAGE_LABEL[pkg]}</p>
                <p className="mt-2 font-mono text-[32px] leading-none tracking-[-0.04em] text-fg tabular-nums">{dollars(PRICE_CENTS[pkg])}</p>
              </>
            ) : (
              <p className="mt-5 text-[15px] text-muted">Select a package to continue.</p>
            )}
            <div className="mt-5 space-y-3">
              <AnimatePresence>
                {Object.keys(errors).length > 0 && <Banner key="fix" tone="bad">Please fix the highlighted fields.</Banner>}
                {submitError && <ErrorBox key="se" message={submitError} />}
              </AnimatePresence>
            </div>
            <Button type="submit" size="lg" className="mt-5 w-full" disabled={submitDisabled}>{busy ? "Submitting…" : "Submit request"}</Button>
            <p className="mt-3 text-xs text-subtle">You will not be charged until you accept a quote.</p>
          </Frame>
        </aside>
      </div>
    </form>
  );
}
