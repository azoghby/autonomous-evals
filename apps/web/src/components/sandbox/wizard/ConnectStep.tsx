"use client";
import { useId } from "react";
import { Chip, Field } from "@/components/ui";
import { CONNECT_MODES, GATEWAY_TARGET_MODELS, type ConnectMode } from "../contract";
import { targetPatch, type WizardForm } from "./form";
import { SelectField, type Errors } from "./controls";

type Props = { form: WizardForm; set: (patch: Partial<WizardForm>) => void; errors: Errors };

/** Only the Endpoint mode can run today; the API rejects the rest with a 422. */
const RUNNABLE_MODES: readonly ConnectMode[] = ["tool_loop"];

const PROTOCOLS = [
  { value: "openai_realtime", label: "OpenAI Realtime" },
  { value: "gemini_live", label: "Gemini Live" },
  { value: "pipecat", label: "Pipecat" },
  { value: "livekit", label: "LiveKit" },
  { value: "custom_pcm", label: "Raw PCM" },
];

export function ConnectStep({ form, set, errors }: Props) {
  const uid = useId();
  const f = (k: keyof WizardForm) => (e: { target: { value: string } }) => set({ [k]: e.target.value } as Partial<WizardForm>);
  const e = (k: string) => errors[k];
  return (
    <div className="space-y-8">
      <fieldset className="min-w-0">
        <legend className="t-eyebrow mb-1 text-fg-2">How should we reach your agent?</legend>
        <p className="mb-3 text-sm text-muted">Endpoint is available now. The other connection modes are coming later.</p>
        <div className="grid gap-px border border-line-2 bg-line-2 md:grid-cols-2">
          {CONNECT_MODES.map((m) => {
            const available = RUNNABLE_MODES.includes(m.mode);
            return (
            <label key={m.mode} className={`group relative flex min-w-0 flex-col gap-1 bg-bg p-4 transition-colors has-checked:bg-accent-soft has-focus-visible:outline-2 has-focus-visible:outline-offset-[-2px] has-focus-visible:outline-accent ${available ? "cursor-pointer hover:bg-bg-raised" : "cursor-not-allowed opacity-60"}`}>
              <input type="radio" name={`${uid}-mode`} value={m.mode} checked={form.mode === m.mode} disabled={!available} onChange={() => set({ mode: m.mode as ConnectMode })} className="sr-only" />
              <span className="flex items-center gap-2 text-[15px] text-fg">
                <span aria-hidden className="size-2.5 shrink-0 rounded-full border border-line-3 group-has-checked:border-accent group-has-checked:bg-accent" />
                {m.label}
                {!available && <Chip tone="muted">Coming later</Chip>}
              </span>
              <span className="text-sm text-muted break-words">{m.summary}</span>
              <span className="mt-1 text-xs text-subtle">{m.loop} · {m.effort}</span>
            </label>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field id={`${uid}-name`} label="Agent name" error={e("name")} value={form.name} onChange={f("name")} placeholder="Support agent" autoComplete="off" />
        <Field id={`${uid}-domain`} label="Domain (optional)" error={e("domain")} value={form.domain} onChange={f("domain")} placeholder="E-commerce support" autoComplete="off" />
      </div>

      <fieldset className="min-w-0 space-y-5">
        <legend className="t-eyebrow mb-4 text-fg-2">{CONNECT_MODES.find((m) => m.mode === form.mode)?.label} details</legend>
        {form.mode === "tool_loop" && (<>
          <div role="radiogroup" aria-label="Which model should we test?" className="grid gap-px border border-line-2 bg-line-2 sm:grid-cols-2">
            {([
              { value: "gateway", title: "Test a model on AI Gateway", text: "Pick a model and we call it for you. We pay for these tokens; they count toward the run budget." },
              { value: "custom", title: "Use my own endpoint", text: "Your OpenAI-compatible URL that returns tool_calls." },
            ] as const).map((o) => (
              <label key={o.value} className="group flex min-w-0 cursor-pointer flex-col gap-1 bg-bg p-4 transition-colors hover:bg-bg-raised has-checked:bg-accent-soft has-focus-visible:outline-2 has-focus-visible:outline-offset-[-2px] has-focus-visible:outline-accent">
                <input type="radio" name={`${uid}-target`} value={o.value} checked={form.target === o.value} onChange={() => set(targetPatch(form, o.value))} className="sr-only" />
                <span className="flex items-center gap-2 text-[15px] text-fg">
                  <span aria-hidden className="size-2.5 shrink-0 rounded-full border border-line-3 group-has-checked:border-accent group-has-checked:bg-accent" />
                  {o.title}
                </span>
                <span className="text-sm text-muted break-words">{o.text}</span>
              </label>
            ))}
          </div>
          {form.target === "gateway" ? (
            <SelectField id={`${uid}-gmodel`} label="Model" value={form.model} onChange={(v) => set({ model: v })} options={GATEWAY_TARGET_MODELS.map((m) => ({ value: m, label: m }))} hint="Metered into the run budget." />
          ) : (<>
            <Field id={`${uid}-ep`} label="Endpoint URL" type="url" inputMode="url" hint="OpenAI-compatible chat completions URL that returns tool_calls. HTTPS only." error={e("integration.endpointUrl")} value={form.endpointUrl} onChange={f("endpointUrl")} placeholder="https://api.example.com/v1/chat/completions" />
            <Field id={`${uid}-model`} label="Model" error={e("integration.model")} value={form.model} onChange={f("model")} placeholder="gpt-4o-mini" />
          </>)}
          <Field id={`${uid}-sys`} multiline rows={5} label="System prompt (optional)" error={e("integration.systemPrompt")} value={form.systemPrompt} onChange={f("systemPrompt")} />
        </>)}
        {(form.mode === "sandbox_api" || form.mode === "staging") && (
          <Field id={`${uid}-chat`} label="Chat endpoint URL" type="url" inputMode="url" hint={form.mode === "sandbox_api" ? "We send simulated-user messages here; your agent calls our per-run sandbox tool URL." : "Your staging chat endpoint. Read-only grading checks are authorized later."} error={e("integration.chatEndpointUrl")} value={form.chatEndpointUrl} onChange={f("chatEndpointUrl")} placeholder="https://staging.example.com/chat" />
        )}
        {form.mode === "repo" && (<>
          <Field id={`${uid}-repo`} label="Repository URL" type="url" inputMode="url" error={e("integration.repoUrl")} value={form.repoUrl} onChange={f("repoUrl")} placeholder="https://github.com/acme/agent" />
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id={`${uid}-ref`} label="Branch or ref" error={e("integration.ref")} value={form.ref} onChange={f("ref")} />
            <Field id={`${uid}-port`} label="Port" type="number" inputMode="numeric" min={1} max={65535} hint="The port your agent listens on." error={e("integration.port")} value={form.port} onChange={f("port")} />
          </div>
          <Field id={`${uid}-install`} label="Install command" error={e("integration.installCommand")} value={form.installCommand} onChange={f("installCommand")} />
          <Field id={`${uid}-start`} label="Start command" error={e("integration.startCommand")} value={form.startCommand} onChange={f("startCommand")} />
          <Field id={`${uid}-path`} label="Chat path" hint="Path on the running agent that accepts chat requests." error={e("integration.chatPath")} value={form.chatPath} onChange={f("chatPath")} />
        </>)}
        {form.mode === "realtime_voice" && (<>
          <Field id={`${uid}-ws`} label="WebSocket URL" type="url" inputMode="url" hint="Must start with wss://" error={e("integration.wsUrl")} value={form.wsUrl} onChange={f("wsUrl")} placeholder="wss://voice.example.com/realtime" />
          <div className="grid gap-5 sm:grid-cols-2">
            <SelectField id={`${uid}-proto`} label="Protocol" value={form.protocol} onChange={(v) => set({ protocol: v as WizardForm["protocol"] })} options={PROTOCOLS} />
            <Field id={`${uid}-rate`} label="Sample rate (Hz)" type="number" inputMode="numeric" error={e("integration.sampleRateHz")} value={form.sampleRateHz} onChange={f("sampleRateHz")} />
          </div>
        </>)}
        <p className="text-xs text-subtle">We never ask for secrets here. API keys and tokens are attached later as credentials, so nothing sensitive is stored in this form.</p>
      </fieldset>
    </div>
  );
}
