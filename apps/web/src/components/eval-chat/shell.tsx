"use client";
import { Children, createContext, isValidElement, useCallback, useContext, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { DEFAULT_PANEL_WIDTH, clampPanelWidth } from "./format";

const WIDTH_KEY = "ec-panel-width";

/* Width store: localStorage-backed with an in-memory fallback when storage is blocked. */
let memWidth: number | null = null;
const listeners = new Set<() => void>();
const readWidth = (): number => {
  if (memWidth !== null) return memWidth;
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return saved ? clampPanelWidth(saved) : DEFAULT_PANEL_WIDTH;
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
};
const subscribeWidth = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};
const persistWidth = (w: number) => {
  memWidth = w;
  try {
    localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    /* storage blocked: the in-memory width still applies for this page view */
  }
  listeners.forEach((l) => l());
};

const subscribeNone = () => () => {};
export const wantsAsk = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).get("ask") === "1";
  } catch {
    return false;
  }
};
/** True when the page was opened with ?ask=1 (read on the client only; false during SSR). */
export const useAskParam = (): boolean => useSyncExternalStore(subscribeNone, wantsAsk, () => false);

export type Shell = {
  /** Effective open state: the user's explicit choice, else defaultOpen / ?ask=1. */
  open: boolean;
  setOpen: (open: boolean) => void;
  width: number;
  /** Live width while dragging; pass commit=true to persist. */
  setWidth: (w: number, commit?: boolean) => void;
};

export const ShellContext = createContext<Shell | null>(null);

export function useShellState(defaultOpen = false): Shell {
  const ask = useAskParam();
  const [explicit, setOpen] = useState<boolean | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const stored = useSyncExternalStore(subscribeWidth, readWidth, () => DEFAULT_PANEL_WIDTH);

  const setWidth = useCallback((w: number, commit = false) => {
    const next = clampPanelWidth(w);
    if (commit) {
      setDrag(null);
      persistWidth(next);
    } else {
      setDrag(next);
    }
  }, []);

  const open = explicit ?? (defaultOpen || ask);
  const width = drag ?? stored;
  return useMemo(() => ({ open, setOpen, width, setWidth }), [open, width, setWidth]);
}

export const useShell = (defaultOpen: boolean): { shell: Shell; docked: boolean } => {
  const ctx = useContext(ShellContext);
  const local = useShellState(defaultOpen);
  return { shell: ctx ?? local, docked: ctx !== null };
};

/** Lays out page content with the copilot docked on the right at >= 1024px. Full-width content below that. */
export function EvalCopilotLayout({ children, copilot }: { children: ReactNode; copilot: ReactNode }) {
  // The layout owns the shared open state, so it reads defaultOpen off the copilot element it was given.
  const el = Children.toArray(copilot).find(isValidElement);
  const defaultOpen = Boolean((el?.props as { defaultOpen?: boolean } | undefined)?.defaultOpen);
  const shell = useShellState(defaultOpen);
  return (
    <ShellContext.Provider value={shell}>
      <div className="ec-layout" data-open={shell.open ? "true" : "false"} style={{ "--ec-w": `${shell.width}px` } as CSSProperties}>
        <div className="ec-layout-main">{children}</div>
        {copilot}
      </div>
    </ShellContext.Provider>
  );
}
