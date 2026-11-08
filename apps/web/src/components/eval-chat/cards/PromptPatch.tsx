"use client";
import { useEffect, useRef, useState } from "react";
import type { PromptPatchCard } from "@/lib/eval-chat/types";
import { ToolFrame } from "../ToolFrame";

const GUTTER = { " ": " ", "+": "+", "-": "-" } as const;
const OP_WORD = { " ": "unchanged", "+": "added", "-": "removed" } as const;
const FEEDBACK_MS = 2000;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

export function PromptPatch({ data }: { data: PromptPatchCard }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    setState((await copyText(data.after)) ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), FEEDBACK_MS);
  };

  return (
    <ToolFrame
      title={data.title}
      stateLabel="Suggestion"
      footer={
        <div className="ec-actions">
          <button type="button" className="ec-btn" data-variant="outline" onClick={() => void copy()}>{state === "copied" ? "Copied" : "Copy patched prompt"}</button>
          <span className="ec-dim" role="status">{state === "failed" ? "Copy failed. Select the text and copy it manually." : state === "copied" ? "Patched prompt copied." : ""}</span>
        </div>
      }
    >
      <p className="ec-text">{data.rationale}</p>
      <div className="ec-code ec-scroll" tabIndex={0} role="region" aria-label="Prompt diff">
        {data.lines.map((l, i) => (
          <div key={i} className="ec-dl" data-op={l.op}>
            <span className="ec-dl-gutter" aria-hidden="true">{GUTTER[l.op]}</span>
            <span className="ec-sr">{OP_WORD[l.op]}: </span>
            <span className="ec-dl-text">{l.text || " "}</span>
          </div>
        ))}
      </div>
      <p className="ec-dim">{data.applyable ? "Ask me to re-run with this prompt to measure the change." : "This agent is not hosted here. Copy the patch into your own prompt, then re-run."}</p>
    </ToolFrame>
  );
}
