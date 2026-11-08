"use client";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { EvalRef } from "@/lib/eval-chat/types";
import { EvalChat } from "./EvalChat";
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from "./format";
import { useAskParam, useShell } from "./shell";
import { useDesktop } from "./useDesktop";

export { EvalCopilotLayout } from "./shell";

type Props = { evalRef: EvalRef; title: string; defaultOpen?: boolean };

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

function Chevron({ dir }: { dir: "left" | "right" | "down" }) {
  const d = dir === "left" ? "M10 3.5 5.5 8l4.5 4.5" : dir === "right" ? "M6 3.5 10.5 8 6 12.5" : "M3.5 6 8 10.5 12.5 6";
  return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
}

/** Per-eval chat. Docked resizable panel at >= 1024px (inside EvalCopilotLayout), bottom sheet with a floating "Ask" button below. */
export function EvalCopilot({ evalRef, title, defaultOpen = false }: Props) {
  const { shell, docked } = useShell(defaultOpen);
  const desktop = useDesktop();
  const ask = useAskParam();
  // Sheet: explicit user choice, else open from ?ask=1 (never unprompted otherwise: a modal must not appear on its own).
  const [sheetChoice, setSheetChoice] = useState<boolean | null>(null);
  const sheet = sheetChoice ?? ask;
  const [wasOpened, setWasOpened] = useState(false);
  const [userOpened, setUserOpened] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const { open, setOpen, width, setWidth } = shell;
  const mountChat = wasOpened || (desktop ? open : sheet);
  const focusOnMount = userOpened || ask;

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (sheet && !dlg.open) dlg.showModal();
    if (!sheet && dlg.open) dlg.close();
  }, [sheet, desktop]);

  const openDock = () => { setWasOpened(true); setUserOpened(true); setOpen(true); };
  const closeDock = () => { setWasOpened(true); setOpen(false); };
  const openSheet = () => { setWasOpened(true); setUserOpened(true); setSheetChoice(true); };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setWidth(drag.current.w + (drag.current.x - e.clientX));
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    setWidth(width, true);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const next = e.key === "ArrowLeft" ? width + step : e.key === "ArrowRight" ? width - step : e.key === "Home" ? MIN_PANEL_WIDTH : e.key === "End" ? MAX_PANEL_WIDTH : null;
    if (next === null) return;
    e.preventDefault();
    setWidth(next, true);
  };

  if (!desktop) {
    return (
      <>
        <button type="button" className="ec-fab" onClick={openSheet}>
          <span className="ec-fab-mark" aria-hidden="true" />Ask
        </button>
        <dialog
          ref={dialogRef}
          className="ec-sheet"
          aria-label={`Eval copilot: ${title}`}
          onClose={() => { setWasOpened(true); setSheetChoice(false); }}
          onClick={(e) => { if (e.target === e.currentTarget) setSheetChoice(false); }}
        >
          <div className="ec-sheet-handle" aria-hidden="true" />
          <header className="ec-head">
            <div className="ec-head-text"><span className="ec-eyebrow">Eval copilot</span><span className="ec-head-title">{title}</span></div>
            <button type="button" className="ec-iconbtn" onClick={() => setSheetChoice(false)} aria-label="Close copilot"><Chevron dir="down" /></button>
          </header>
          {mountChat ? <EvalChat evalRef={evalRef} title={title} autoFocus={focusOnMount} /> : null}
        </dialog>
      </>
    );
  }

  return (
    <aside className="ec-dock" data-open={open ? "true" : "false"} data-floating={docked ? "false" : "true"} data-dragging={dragging ? "true" : "false"} style={docked ? undefined : { width: open ? width : undefined }} aria-label="Eval copilot">
      {open ? (
        <div
          className="ec-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize copilot panel"
          aria-valuenow={width}
          aria-valuemin={MIN_PANEL_WIDTH}
          aria-valuemax={MAX_PANEL_WIDTH}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        />
      ) : (
        <button type="button" className="ec-rail" aria-expanded="false" onClick={openDock}>
          <Chevron dir="left" />
          <span className="ec-rail-label">Ask about this eval</span>
        </button>
      )}
      <div className="ec-panel" hidden={!open}>
        <header className="ec-head">
          <div className="ec-head-text"><span className="ec-eyebrow">Eval copilot</span><span className="ec-head-title">{title}</span></div>
          <button type="button" className="ec-iconbtn" onClick={closeDock} aria-label="Collapse copilot panel" aria-expanded="true"><Chevron dir="right" /></button>
        </header>
        {mountChat ? <EvalChat evalRef={evalRef} title={title} autoFocus={focusOnMount} /> : null}
      </div>
    </aside>
  );
}
