"use client";
import { useId } from "react";
import { Field } from "@/components/ui";

export interface EndpointDraft {
  url: string; model: string; apiKey: string; systemPrompt: string; referenceText: string;
}
export const emptyEndpoint = (): EndpointDraft => ({ url: "", model: "", apiKey: "", systemPrompt: "", referenceText: "" });

/** Strip blanks so optional Zod fields are omitted rather than empty strings. */
export function endpointPayload(e: EndpointDraft) {
  return {
    url: e.url.trim(),
    model: e.model.trim(),
    ...(e.apiKey ? { apiKey: e.apiKey } : {}),
    systemPrompt: e.systemPrompt,
    ...(e.referenceText.trim() ? { referenceText: e.referenceText } : {}),
  };
}

export function EndpointFields({ value, onChange, errors, legend }: {
  value: EndpointDraft; onChange: (v: EndpointDraft) => void; errors: Record<string, string>; legend?: string;
}) {
  const uid = useId();
  const set = (k: keyof EndpointDraft) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <fieldset className="space-y-5">
      {legend && <legend className="t-eyebrow mb-4 text-fg-2">{legend}</legend>}
      <Field id={`${uid}-url`} label="Endpoint URL" hint="OpenAI-compatible chat completions endpoint. HTTPS only." error={errors.url}
        type="url" inputMode="url" placeholder="https://api.example.com/v1/chat/completions" value={value.url} onChange={set("url")} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id={`${uid}-model`} label="Model" error={errors.model} placeholder="gpt-4o-mini" value={value.model} onChange={set("model")} />
        <Field id={`${uid}-key`} label="API key" hint="Encrypted at rest, deleted 24h after delivery. Never shown to our agents." error={errors.apiKey}
          type="password" autoComplete="off" value={value.apiKey} onChange={set("apiKey")} />
      </div>
      <Field id={`${uid}-sys`} multiline rows={5} label="System prompt" error={errors.systemPrompt} value={value.systemPrompt} onChange={set("systemPrompt")} />
      <Field id={`${uid}-ref`} multiline rows={4} label="Reference text (optional)" hint="Without it, factual correctness is reported as not assessed." error={errors.referenceText}
        value={value.referenceText} onChange={set("referenceText")} />
    </fieldset>
  );
}
