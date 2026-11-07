"use client";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IntakeInput, MAX_TRACE_BYTES, PACKAGES, PRICE_CENTS, type Package } from "@ae/core/contracts/index";
import { api, ApiError, dollars, errMsg, PACKAGE_LABEL } from "@/lib/client/api";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Banner, Btn, cx, ErrorBox, Field, PageTitle, Textarea } from "./ui";
import { EASE, SPRING, Stagger, StaggerItem } from "./motion";
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
    <form onSubmit={submit} noValidate className="space-y-12">
      <PageTitle title="New request" sub="Pilot pricing. Pick a package, tell us what to test, and an agent will quote you from the fixed price table." />

      <fieldset>
        <legend className="mb-3 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-subtle">1 · Package</legend>
        <LayoutGroup id="pkg">
          <Stagger className="border-t border-line" delay={0.1}>
            <div role="radiogroup">
              {PACKAGES.map((p) => (
                <StaggerItem key={p} className="border-b border-line">
                  <button type="button" role="radio" aria-checked={pkg === p} onClick={() => { setPkg(p); setErrors({}); }}
                    className="relative block w-full px-4 py-5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent-bright sm:px-5">
                    {pkg === p && (
                      <motion.span layoutId="pkg-highlight" aria-hidden transition={SPRING} className="absolute inset-0 rounded-md bg-fg/[0.04]" />
                    )}
                    {pkg === p && <motion.span layoutId="pkg-bar" aria-hidden transition={SPRING} className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
                    <span className="relative flex items-baseline justify-between gap-4">
                      <span className={cx("text-lg font-medium transition-colors", pkg === p ? "text-fg" : "text-fg/75")}>{PACKAGE_LABEL[p]}</span>
                      <span className="font-mono text-lg tabular-nums text-fg">{dollars(PRICE_CENTS[p])}</span>
                    </span>
                    <span className="relative mt-1 block max-w-xl text-sm text-muted">{BLURB[p]}</span>
                  </button>
                </StaggerItem>
              ))}
            </div>
          </Stagger>
        </LayoutGroup>
      </fieldset>

      <AnimatePresence mode="wait" initial={false}>
        {pkg && (
          <motion.div key={pkg} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.4, ease: EASE }} className="space-y-8">
            <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-subtle">2 · {PACKAGE_LABEL[pkg]} details</h2>

            {pkg === "trace_audit" && (
              <div className="space-y-5">
                <Field label="Transcript or tool log" hint={`JSON or text, up to ${MAX_TRACE_BYTES / 1024} KB. Currently ${(traceBytes / 1024).toFixed(1)} KB.`} error={errors.trace ?? traceErr ?? undefined}>
                  <Textarea className="min-h-56 font-mono text-xs" value={trace} onChange={(e) => setTrace(e.target.value)} placeholder="Paste your agent's transcript or tool log here" />
                </Field>
                <Field label="Or upload a file" hint=".json or .txt, read in your browser">
                  <input type="file" accept=".json,.txt,application/json,text/plain" onChange={(e) => void onFile(e.target.files?.[0])}
                    className="block w-full text-sm text-muted file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-line-strong file:bg-transparent file:px-4 file:py-2 file:text-fg hover:file:border-accent-bright" />
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
              <div className="space-y-8">
                <Field label="Evaluation mode">
                  <LayoutGroup id="mode">
                    <div className="inline-flex gap-1 rounded-md border border-line p-1" role="radiogroup">
                      {(["text", "workflow"] as const).map((m) => (
                        <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                          className={cx("relative rounded px-4 py-1.5 text-sm transition-colors", mode === m ? "text-fg" : "text-subtle hover:text-fg")}>
                          {mode === m && <motion.span layoutId="mode-pill" transition={SPRING} className="absolute inset-0 rounded bg-accent/25 ring-1 ring-inset ring-accent" />}
                          <span className="relative">{m === "text" ? "Text Eval" : "Workflow Eval"}</span>
                        </button>
                      ))}
                    </div>
                  </LayoutGroup>
                </Field>
                <EndpointFields legend="Version A" value={endpointA} onChange={setEndpointA} errors={sub(errors, "endpointA")} />
                <EndpointFields legend="Version B" value={endpointB} onChange={setEndpointB} errors={sub(errors, "endpointB")} />
              </div>
            )}

            <Field label="Notes (optional)" error={errors.notes}>
              <Textarea className="min-h-20" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>

            <div>
              <label className="flex cursor-pointer items-start gap-3 text-sm text-fg/85">
                <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#2F6BFF]" />
                <span>I&apos;m authorized to test this system.</span>
              </label>
              {errors.authorizedToTest && <p role="alert" className="mt-1 text-xs text-danger">{errors.authorizedToTest}</p>}
            </div>

            <AnimatePresence>
              {Object.keys(errors).length > 0 && <Banner key="fix" tone="bad">Please fix the highlighted fields.</Banner>}
              {submitError && <ErrorBox key="se" message={submitError} />}
            </AnimatePresence>
            <div className="flex flex-wrap items-center gap-5">
              <Btn type="submit" loading={busy}>Submit request · {dollars(PRICE_CENTS[pkg])}</Btn>
              <p className="text-xs text-subtle">You will not be charged until you accept a quote.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}
