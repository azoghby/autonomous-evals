"use client";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { COUNTER_THRESHOLD, MAX_MESSAGE_LENGTH } from "./format";

type Props = {
  streaming: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
};

const subscribeNone = () => () => {};
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Auto-growing composer. Enter or Cmd/Ctrl+Enter sends, Shift+Enter inserts a newline, IME composition never sends. */
export function Composer({ streaming, disabled, autoFocus, onSend, onStop }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const mac = useSyncExternalStore(subscribeNone, isMac, () => true);

  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [text]);

  const canSend = !disabled && !streaming && text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };
  const remaining = MAX_MESSAGE_LENGTH - text.length;

  return (
    <form className="ec-composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <div className="ec-composer-box" data-disabled={disabled ? "true" : "false"}>
        <textarea
          ref={ref}
          className="ec-input"
          rows={1}
          value={text}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label="Message to the eval copilot"
          placeholder={disabled ? "Loading conversation…" : "Ask about this eval"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {streaming ? (
          <button type="button" className="ec-send" data-stop="true" onClick={onStop} aria-label="Stop generating"><span className="ec-stop-glyph" aria-hidden="true" /></button>
        ) : (
          <button type="submit" className="ec-send" disabled={!canSend} aria-label="Send message"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></button>
        )}
      </div>
      <div className="ec-composer-foot">
        <span className="ec-hint">{mac ? "⌘↵" : "Ctrl↵"} to send · Shift+↵ for a new line</span>
        {text.length >= COUNTER_THRESHOLD ? <span className="ec-count" data-tone={remaining <= 0 ? "danger" : "warn"} role="status">{remaining} left</span> : null}
      </div>
    </form>
  );
}
