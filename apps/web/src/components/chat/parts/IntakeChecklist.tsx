"use client";
import { useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { useNovaActions } from "../context";
import { IconCheck } from "../icons";
import { ATTACHMENT_ACCEPT, ATTACHMENT_MAX_BYTES, type ChecklistItem, type IntakeChecklistOutput } from "../nova-types";
import { ToolFrame } from "./ToolFrame";

interface Props { output: IntakeChecklistOutput; interactive: boolean; index?: number }

const httpsProblem = (raw: string): string | null => {
  try { return new URL(raw).protocol === "https:" ? null : "Use an https:// URL."; } catch { return "That isn't a URL."; }
};

function EndpointForm({ onDone }: { onDone: () => void }) {
  const { send, busy } = useNovaActions();
  const id = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const url = value.trim();
    const problem = httpsProblem(url);
    if (problem) { setError(problem); return; }
    send({ fields: { endpointUrl: url } }, `Endpoint: ${url}`);
    onDone();
  };
  return (
    <form className="nv-inline-form" onSubmit={submit} noValidate>
      <label htmlFor={id} className="sr-only">Agent endpoint URL</label>
      <input
        id={id} className="input" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://agent.example.com/v1/chat/completions"
        value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined} autoFocus
      />
      <button type="submit" className="nv-btn" data-v="primary" disabled={busy || !value.trim()}>Use endpoint</button>
      {error && <p id={`${id}-err`} role="alert" className="basis-full text-[13px] text-danger">{error}</p>}
    </form>
  );
}

function RowActions({ item, onEndpoint, onBrowse, onFocusModels }: { item: ChecklistItem; onEndpoint: () => void; onBrowse: () => void; onFocusModels: () => void }) {
  const { send, busy } = useNovaActions();
  if (item.id === "agent" && item.state === "missing") {
    return (
      <div className="nv-check-actions">
        <button type="button" className="nv-btn" onClick={onFocusModels} disabled={busy}>Pick a model</button>
        <button type="button" className="nv-btn" data-v="ghost" onClick={onEndpoint} disabled={busy}>Paste endpoint</button>
      </div>
    );
  }
  if (item.id === "tools" && item.state === "missing") {
    return (
      <div className="nv-check-actions">
        <button type="button" className="nv-btn" disabled={busy} onClick={() => send({ fields: { prebuiltWorld: "acme-support" } }, "Use the Acme sample world.")}>Use sample world</button>
        <button type="button" className="nv-btn" data-v="ghost" onClick={onBrowse} disabled={busy}>Upload spec</button>
      </div>
    );
  }
  if (item.state === "optional") {
    return <div className="nv-check-actions"><button type="button" className="nv-btn" data-v="ghost" onClick={onBrowse} disabled={busy}>Add file</button></div>;
  }
  return null;
}

/** What Nova has and what it still needs, with inline ways to supply each missing piece. */
export function IntakeChecklist({ output, interactive, index }: Props) {
  const { sendFiles, busy } = useNovaActions();
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [endpointOpen, setEndpointOpen] = useState(false);
  const [over, setOver] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const done = output.items.filter((i) => i.required && i.state === "done").length;
  const required = output.items.filter((i) => i.required).length;

  const upload = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    setErrors(await sendFiles(files));
    if (fileRef.current) fileRef.current.value = "";
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); void upload(e.dataTransfer.files); };
  const focusModels = () => {
    const first = rootRef.current?.closest("[data-nv-message]")?.querySelector<HTMLInputElement>("[data-nv-models] input");
    first?.focus();
    first?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  };

  return (
    <div ref={rootRef}>
      <ToolFrame
        title="Intake" index={index} labelledBy={titleId}
        state={output.ready ? "done" : "partial"} stateLabel={output.ready ? "Everything collected" : `${done} of ${required} required`}
        tone={output.ready ? "ok" : "accent"}
      >
        <ul className="nv-check">
          {output.items.map((item) => (
            <li key={item.id} className="nv-check-row" data-s={item.state}>
              <span className="nv-mark" data-s={item.state} aria-hidden="true">{item.state === "done" && <IconCheck />}</span>
              <span className="nv-check-label">
                {item.label}{!item.required && <em>optional</em>}
                <span className="sr-only">{item.state === "done" ? ", collected" : item.state === "missing" ? ", still needed" : ", not provided"}</span>
              </span>
              <span className="nv-check-detail">{item.detail}</span>
              {interactive && <RowActions item={item} onEndpoint={() => setEndpointOpen((o) => !o)} onBrowse={() => fileRef.current?.click()} onFocusModels={focusModels} />}
              {interactive && item.id === "agent" && endpointOpen && item.state === "missing" && <EndpointForm onDone={() => setEndpointOpen(false)} />}
            </li>
          ))}
        </ul>
        {output.notes.length > 0 && <p className="nv-notes">{output.notes.join(" ")}</p>}
        {interactive && !output.ready && (
          <>
            <div
              className="nv-drop" role="button" tabIndex={0} data-over={over} aria-disabled={busy}
              aria-label="Upload an OpenAPI spec, MCP tool list, schema or policies"
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
            >
              <span><b>Drop files</b> or click to browse</span>
              <small>OpenAPI, MCP tools JSON, CREATE TABLE schema, policies. Up to {ATTACHMENT_MAX_BYTES.openapi / 1000} KB</small>
            </div>
            {errors.length > 0 && <ul className="nv-file-errors" role="alert">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          </>
        )}
        <input ref={fileRef} type="file" accept={ATTACHMENT_ACCEPT} multiple hidden onChange={(e) => void upload(e.target.files)} />
      </ToolFrame>
    </div>
  );
}
