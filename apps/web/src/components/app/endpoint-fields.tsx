"use client";
import { Field, Input, Textarea } from "./ui";

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
  const set = (k: keyof EndpointDraft) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <fieldset className="space-y-4">
      {legend && <legend className="mb-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-subtle">{legend}</legend>}
      <Field label="Endpoint URL" hint="OpenAI-compatible chat completions endpoint. HTTPS only." error={errors.url}>
        <Input type="url" inputMode="url" placeholder="https://api.example.com/v1/chat/completions" value={value.url} onChange={set("url")} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Model" error={errors.model}>
          <Input placeholder="gpt-4o-mini" value={value.model} onChange={set("model")} />
        </Field>
        <Field label="API key" hint="Encrypted at rest, deleted 24h after delivery. Never shown to our agents." error={errors.apiKey}>
          <Input type="password" autoComplete="off" value={value.apiKey} onChange={set("apiKey")} />
        </Field>
      </div>
      <Field label="System prompt" error={errors.systemPrompt}>
        <Textarea value={value.systemPrompt} onChange={set("systemPrompt")} />
      </Field>
      <Field label="Reference text (optional)" hint="Without it, factual correctness is reported as not assessed." error={errors.referenceText}>
        <Textarea value={value.referenceText} onChange={set("referenceText")} />
      </Field>
    </fieldset>
  );
}
