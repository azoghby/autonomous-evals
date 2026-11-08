"use client";
import { useId, useState, type FormEvent } from "react";
import { useNovaActions } from "../context";
import type { ModelPickerOutput } from "../nova-types";
import { ToolFrame } from "./ToolFrame";

interface Props { output: ModelPickerOutput; interactive: boolean; index?: number }

const PROVIDER: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google" };

/** Hosted models from the sandbox allowlist; we run the model with the customer's system prompt. */
export function ModelPicker({ output, interactive, index }: Props) {
  const { send, busy } = useNovaActions();
  const id = useId();
  const [model, setModel] = useState(output.selected ?? "");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsPrompt = !output.hasSystemPrompt;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!model) { setError("Pick a model."); return; }
    if (needsPrompt && prompt.trim().length < 10) { setError("Paste the system prompt your agent runs with."); return; }
    send({ fields: { model: model as never, ...(needsPrompt ? { systemPrompt: prompt.trim() } : {}) } }, `Model: ${model}${needsPrompt ? " (with a system prompt)" : ""}`);
  };

  return (
    <ToolFrame title="Hosted model" index={index} state={output.selected ? "done" : "idle"} stateLabel={output.selected ? output.selected : "We run it for you"} labelledBy={`${id}-t`}>
      <form onSubmit={submit} noValidate>
        <fieldset className="nv-models" data-nv-models disabled={!interactive || busy} aria-describedby={`${id}-hint`}>
          <legend className="sr-only">Model to test</legend>
          {output.models.map((m) => (
            <label key={m.id} className="nv-model">
              <input type="radio" name={`${id}-model`} value={m.id} checked={model === m.id} onChange={() => { setModel(m.id); setError(null); }} />
              <span className="nv-radio" aria-hidden="true" />
              <span className="nv-model-name">{m.name}</span>
              <span className="nv-model-prov">{PROVIDER[m.provider] ?? m.provider}</span>
            </label>
          ))}
        </fieldset>
        <p id={`${id}-hint`} className="mt-2 text-[12px] text-subtle">Runs through our AI Gateway; no keys needed. Have your own endpoint? Paste it in the intake above.</p>
        {interactive && (
          <div className="nv-model-form">
            {needsPrompt && (
              <>
                <label htmlFor={`${id}-p`} className="text-[13px] text-fg-2">System prompt</label>
                <textarea
                  id={`${id}-p`} className="input" value={prompt} maxLength={50_000} placeholder="You are the support agent for Acme. Help customers with orders and refunds…"
                  onChange={(e) => { setPrompt(e.target.value); setError(null); }} aria-invalid={!!error && needsPrompt && !prompt.trim()}
                />
              </>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : <span />}
              <button type="submit" className="nv-btn" data-v="primary" disabled={busy || !model}>Use this model</button>
            </div>
          </div>
        )}
      </form>
    </ToolFrame>
  );
}
