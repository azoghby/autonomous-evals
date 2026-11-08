"use client";
import { useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Button } from "@/components/ui";

export type Errors = Record<string, string>;

export function SelectField({ id, label, hint, value, onChange, options }: {
  id: string; label: string; hint?: ReactNode; value: string; onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] leading-none text-fg-2">{label}</label>
      <select id={id} className="select" value={value} aria-describedby={hint ? `${id}-hint` : undefined} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint && <p id={`${id}-hint`} className="text-xs text-subtle">{hint}</p>}
    </div>
  );
}

const MAX_FILE_BYTES = 2_000_000;

/** Reads a local text file into the parent's textarea. */
export function FileLoad({ accept, onText, label = "Upload file" }: { accept: string; onText: (text: string) => void; label?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const id = useId();
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setErr("File is larger than 2 MB."); return; }
    const reader = new FileReader();
    reader.onload = () => { setErr(null); onText(String(reader.result ?? "")); };
    reader.onerror = () => setErr("Could not read that file.");
    reader.readAsText(file);
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <input ref={ref} id={id} type="file" accept={accept} onChange={onChange} className="sr-only" tabIndex={-1} aria-label={label} />
      <Button variant="outline" size="sm" onClick={() => ref.current?.click()}>{label}</Button>
      <span className="text-xs text-subtle">{accept.replaceAll(",", " ")}</span>
      {err && <span role="alert" className="text-xs text-danger">{err}</span>}
    </div>
  );
}

export function ErrorList({ errors }: { errors: Errors }) {
  const entries = Object.entries(errors);
  if (entries.length === 0) return null;
  return (
    <div role="alert" className="border border-danger/40 px-4 py-3 text-sm text-danger">
      <p>Fix {entries.length === 1 ? "this issue" : `these ${entries.length} issues`} to continue:</p>
      <ul className="mt-1 list-disc pl-5 text-xs break-words">
        {entries.map(([k, v]) => <li key={k}>{v}</li>)}
      </ul>
    </div>
  );
}
