"use client";
import { useCallback, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type Ref } from "react";
import { readAttachments } from "./attachments";
import { IconArrowUp, IconClip, IconFile, IconStop, IconX } from "./icons";
import { ATTACHMENT_ACCEPT, ATTACHMENT_KINDS, ATTACHMENT_LABEL, attachmentProblem, type AttachmentKind, type ChatAttachment } from "./nova-types";

export interface ComposerApi { setText: (t: string) => void; openPicker: () => void; addFiles: (f: FileList | File[]) => void; focus: () => void }

interface Props {
  api?: Ref<ComposerApi>;
  streaming: boolean;
  disabled?: boolean;
  onSend: (text: string, files: ChatAttachment[]) => void;
  onStop: () => void;
  placeholder?: string;
}

const MAX_HEIGHT = 220;
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Auto-growing composer: ⌘↵ / Ctrl↵ sends, files attach by picker or drop, Stop while Nova streams. */
export function Composer({ api, streaming, disabled, onSend, onStop, placeholder }: Props) {
  const id = useId();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<ChatAttachment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const [mac, setMac] = useState(true);

  useLayoutEffect(() => { setMac(isMac()); }, []);
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(MAX_HEIGHT, ta.scrollHeight)}px`;
    ta.style.overflowY = ta.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

  const addFiles = useCallback(async (list: FileList | File[]) => {
    const res = await readAttachments(list, files.length);
    setFiles((f) => [...f, ...res.files]);
    setErrors(res.errors);
    taRef.current?.focus();
  }, [files.length]);

  useImperativeHandle(api, () => ({
    setText: (t) => { setText(t); requestAnimationFrame(() => { taRef.current?.focus(); taRef.current?.setSelectionRange(t.length, t.length); }); },
    openPicker: () => fileRef.current?.click(),
    addFiles: (f) => void addFiles(f),
    focus: () => taRef.current?.focus(),
  }), [addFiles]);

  const problems = files.map(attachmentProblem);
  const canSend = !disabled && !streaming && (text.trim().length > 0 || files.length > 0) && problems.every((p) => !p);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    onSend(text.trim(), files);
    setText("");
    setFiles([]);
    setErrors([]);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    if (e.key === "Escape" && streaming) { e.preventDefault(); onStop(); }
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files); };
  const setKind = (i: number, kind: AttachmentKind) => setFiles((f) => f.map((x, j) => (j === i ? { ...x, kind } : x)));

  return (
    <form className="nv-composer" data-over={over} onSubmit={submit} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop} aria-label="Message Nova">
      {files.length > 0 && (
        <ul className="nv-composer-files" aria-label="Attached files">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="nv-composer-file" data-invalid={!!problems[i]} title={problems[i] ?? undefined}>
              <IconFile aria-hidden="true" />
              <span>{f.name}</span>
              <small>{Math.max(1, Math.round(f.content.length / 1000))} KB</small>
              <label className="sr-only" htmlFor={`${id}-k${i}`}>File type for {f.name}</label>
              <select id={`${id}-k${i}`} value={f.kind} onChange={(e) => setKind(i, e.target.value as AttachmentKind)}>
                {ATTACHMENT_KINDS.map((k) => <option key={k} value={k}>{ATTACHMENT_LABEL[k]}</option>)}
              </select>
              <button type="button" className="nv-x" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}><IconX width={12} height={12} /></button>
            </li>
          ))}
        </ul>
      )}
      <label htmlFor={`${id}-ta`} className="sr-only">Message</label>
      <textarea
        id={`${id}-ta`} ref={taRef} rows={1} value={text} maxLength={8000} disabled={disabled}
        placeholder={placeholder ?? "Describe your agent, paste an endpoint, or drop an OpenAPI spec"}
        onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
        onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void addFiles(e.clipboardData.files); } }}
        aria-describedby={errors.length || problems.some(Boolean) ? `${id}-err` : `${id}-hint`}
      />
      {(errors.length > 0 || problems.some(Boolean)) && (
        <ul id={`${id}-err`} role="alert" className="px-4 pb-1 text-[12px] text-danger">
          {[...errors, ...problems.filter((p): p is string => !!p)].map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      <div className="nv-composer-bar">
        <span className="flex items-center gap-1">
          <button type="button" className="nv-icon-btn" aria-label="Attach files" title="Attach an OpenAPI spec, MCP tool list, schema or policies" onClick={() => fileRef.current?.click()} disabled={disabled}>
            <IconClip />
          </button>
          <input ref={fileRef} type="file" accept={ATTACHMENT_ACCEPT} multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
          <span id={`${id}-hint`} className="nv-kbd"><kbd>{mac ? "⌘" : "Ctrl"}</kbd> <kbd>↵</kbd> to send</span>
        </span>
        {streaming ? (
          <button type="button" className="nv-send" data-stop="true" onClick={onStop} aria-label="Stop Nova"><IconStop /></button>
        ) : (
          <button type="submit" className="nv-send" disabled={!canSend} aria-label="Send message"><IconArrowUp /></button>
        )}
      </div>
    </form>
  );
}
