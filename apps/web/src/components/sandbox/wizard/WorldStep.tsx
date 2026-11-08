"use client";
import { useId } from "react";
import { Button, Field } from "@/components/ui";
import { DATA_FORMAT_LABELS, PREBUILT_ENVS, TOOLS_FORMAT_LABELS, type DataFormat, type PrebuiltEnvId, type ToolsFormat } from "../contract";
import { MAX_POLICIES, type PolicyRow, type WizardForm } from "./form";
import { FileLoad, SelectField, type Errors } from "./controls";

type Props = { form: WizardForm; set: (patch: Partial<WizardForm>) => void; errors: Errors; onExample: () => void };

const options = <T extends string>(labels: Record<T, string>) => (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));

export function WorldStep({ form, set, errors, onExample }: Props) {
  const uid = useId();
  const setPolicy = (i: number, patch: Partial<PolicyRow>) =>
    set({ policies: form.policies.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const removePolicy = (i: number) => set({ policies: form.policies.filter((_, j) => j !== i) });
  const addPolicy = () => set({ policies: [...form.policies, { title: "", text: "" }] });
  const accept = form.toolsFormat === "openapi" ? ".json,.yaml,.yml" : ".json";

  const choice = (value: WizardForm["worldSource"], title: string, text: string) => (
    <label className="group flex min-w-0 cursor-pointer flex-col gap-1 bg-bg p-4 transition-colors hover:bg-bg-raised has-checked:bg-accent-soft has-focus-visible:outline-2 has-focus-visible:outline-offset-[-2px] has-focus-visible:outline-accent">
      <input type="radio" name={`${uid}-src`} value={value} checked={form.worldSource === value} onChange={() => set({ worldSource: value })} className="sr-only" />
      <span className="flex items-center gap-2 text-[15px] text-fg">
        <span aria-hidden className="size-2.5 shrink-0 rounded-full border border-line-3 group-has-checked:border-accent group-has-checked:bg-accent" />
        {title}
      </span>
      <span className="text-sm text-muted break-words">{text}</span>
    </label>
  );

  const picker = (
    <fieldset className="min-w-0 space-y-4">
      <legend className="t-eyebrow mb-2 text-fg-2">World</legend>
      <div role="radiogroup" className="grid gap-px border border-line-2 bg-line-2 sm:grid-cols-2">
        {choice("prebuilt", "Use a prebuilt world", "Skip the setup: start from a ready-made environment with tools, data and policies.")}
        {choice("custom", "Describe your own", "Paste your tool definitions, data shape and policies.")}
      </div>
    </fieldset>
  );

  if (form.worldSource === "prebuilt") {
    return (
      <div className="space-y-8">
        {picker}
        <fieldset className="min-w-0 space-y-3">
          <legend className="t-eyebrow mb-2 text-fg-2">Prebuilt environment</legend>
          {PREBUILT_ENVS.length > 1 ? (
            <SelectField id={`${uid}-pre`} label="Environment" value={form.prebuilt} onChange={(v) => set({ prebuilt: v as PrebuiltEnvId })} options={PREBUILT_ENVS.map((p) => ({ value: p.id, label: p.name }))} />
          ) : null}
          <ul className="space-y-2">
            {PREBUILT_ENVS.filter((p) => p.id === form.prebuilt).map((p) => (
              <li key={p.id} className="border border-line-2 p-4">
                <p className="text-[15px] text-fg">{p.name}</p>
                <p className="mt-1 text-sm text-muted break-words">{p.summary}</p>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted">Your agent needs to call this world&apos;s tools; the suite is generated from its policies and workflows.</p>
        </fieldset>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {picker}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-line-2 px-4 py-3">
        <p className="min-w-0 text-sm text-muted">In a hurry? Fill a small support-agent example.</p>
        <Button variant="outline" size="sm" onClick={onExample}>Load example</Button>
      </div>

      <fieldset className="min-w-0 space-y-4">
        <legend className="t-eyebrow mb-2 text-fg-2">Tools</legend>
        <SelectField id={`${uid}-tf`} label="Format" value={form.toolsFormat} onChange={(v) => set({ toolsFormat: v as ToolsFormat })} options={options(TOOLS_FORMAT_LABELS)} />
        <Field id={`${uid}-tc`} multiline rows={10} spellCheck={false} label="Tool definitions" hint="Paste, or upload a file below." error={errors["world.tools.content"]} value={form.toolsContent} onChange={(e) => set({ toolsContent: e.target.value })} className="[&_textarea]:w-full [&_textarea]:font-mono [&_textarea]:text-[13px]" />
        <FileLoad accept={accept} label="Upload tools file" onText={(t) => set({ toolsContent: t })} />
      </fieldset>

      <fieldset className="min-w-0 space-y-4">
        <legend className="t-eyebrow mb-2 text-fg-2">Data shape</legend>
        <SelectField id={`${uid}-df`} label="Format" value={form.dataFormat} onChange={(v) => set({ dataFormat: v as DataFormat })} options={options(DATA_FORMAT_LABELS)} hint={form.dataFormat === "infer" ? "We will design tables from your tool schemas and seed fake data." : undefined} />
        {form.dataFormat !== "infer" && (<>
          <Field id={`${uid}-dc`} multiline rows={8} spellCheck={false} label={form.dataFormat === "ddl" ? "Postgres DDL" : "Sample CSV"} error={errors["world.data.content"]} value={form.dataContent} onChange={(e) => set({ dataContent: e.target.value })} className="[&_textarea]:w-full [&_textarea]:font-mono [&_textarea]:text-[13px]" />
          <FileLoad accept={form.dataFormat === "ddl" ? ".sql,.txt" : ".csv,.txt"} label="Upload data file" onText={(t) => set({ dataContent: t })} />
        </>)}
      </fieldset>

      <fieldset className="min-w-0 space-y-4">
        <legend className="t-eyebrow mb-2 text-fg-2">Policies ({form.policies.length}/{MAX_POLICIES})</legend>
        <p className="text-sm text-muted">Rules your agent must follow. Each becomes checks in the suite.</p>
        {form.policies.map((p, i) => (
          <div key={i} className="space-y-3 border border-line-2 p-4">
            <Field id={`${uid}-pt${i}`} label={`Policy ${i + 1} title`} error={errors[`world.policies.${i}.title`]} value={p.title} onChange={(e) => setPolicy(i, { title: e.target.value })} />
            <Field id={`${uid}-px${i}`} multiline rows={4} label={`Policy ${i + 1} text`} error={errors[`world.policies.${i}.text`]} value={p.text} onChange={(e) => setPolicy(i, { text: e.target.value })} className="[&_textarea]:w-full" />
            <Button variant="ghost" size="sm" onClick={() => removePolicy(i)} aria-label={`Remove policy ${i + 1}`}>Remove</Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={addPolicy} disabled={form.policies.length >= MAX_POLICIES}>Add policy</Button>
        {errors["world.policies"] && <p role="alert" className="text-xs text-danger">{errors["world.policies"]}</p>}
      </fieldset>

      <Field id={`${uid}-wn`} multiline rows={4} label="Workflow notes (optional)" hint="Key flows you care about, e.g. refunds, address changes, escalations." error={errors["world.workflowNotes"]} value={form.workflowNotes} onChange={(e) => set({ workflowNotes: e.target.value })} className="[&_textarea]:w-full" />
    </div>
  );
}
