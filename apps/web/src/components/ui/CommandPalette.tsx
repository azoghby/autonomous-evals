"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { hasSessionHint, writeSessionHint } from "@/lib/session-hint";
import { staticItemsFor, recentItems, searchPalette, wrapIndex, type PaletteItem, type RecentEval } from "@/lib/palette";

type Recent = { phase: "idle" | "loading" | "signed_out" | "error" } | { phase: "ready"; items: PaletteItem[] };

const OPEN_EVENT = "se:open-palette";

/** Opens the palette from anywhere (e.g. a button) without prop drilling. */
export const openCommandPalette = () => window.dispatchEvent(new Event(OPEN_EVENT));

function useRecentEvals(open: boolean, signedIn: boolean): Recent {
  const [state, setState] = useState<Recent>({ phase: "idle" });
  // Fetch once per page load; retry only when reopened after an error or an aborted (closed mid-flight) request.
  const settled = useRef(false);
  useEffect(() => {
    // Signed-out visitors never hit /api/evals (it would only 401 into the console).
    if (!open || !signedIn || settled.current) return;
    const ctl = new AbortController();
    setState({ phase: "loading" });
    fetch("/api/evals", { signal: ctl.signal, cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) { settled.current = true; writeSessionHint(false); setState({ phase: "signed_out" }); return; }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { evals?: RecentEval[] };
        settled.current = true;
        setState({ phase: "ready", items: recentItems(body.evals ?? []) });
      })
      .catch(() => setState({ phase: ctl.signal.aborted ? "idle" : "error" }));
    return () => ctl.abort();
  }, [open, signedIn]);
  return state;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const listId = useId();
  const [signedIn, setSignedIn] = useState(false);
  const recent = useRecentEvals(open, signedIn);
  // A 401 despite the hint (expired session) downgrades to signed out.
  const viewerSignedIn = signedIn && recent.phase !== "signed_out";

  useEffect(() => setMounted(true), []);

  const show = useCallback(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setSignedIn(hasSessionHint(document.cookie));
    setQuery("");
    setActive(0);
    setOpen(true);
  }, []);
  const hide = useCallback(() => {
    setOpen(false);
    returnFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) hide(); else show();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, show);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(OPEN_EVENT, show); };
  }, [open, show, hide]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const results = useMemo(() => {
    const base = staticItemsFor(viewerSignedIn);
    const items = recent.phase === "ready" ? [...recent.items, ...base] : base;
    return searchPalette(items, query);
  }, [recent, query, viewerSignedIn]);
  const current = Math.min(active, Math.max(results.length - 1, 0));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const go = (item: PaletteItem | undefined) => {
    if (!item) return;
    setOpen(false);
    router.push(item.href);
  };

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(wrapIndex(current + 1, results.length)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(wrapIndex(current - 1, results.length)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(Math.max(results.length - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); go(results[current]); }
    else if (e.key === "Escape") { e.preventDefault(); hide(); }
    else if (e.key === "Tab") e.preventDefault(); // focus stays in the dialog; arrows move the selection
  };

  if (!open || !mounted) return null;

  let lastGroup = "";
  const status = recent.phase === "loading" ? "Loading your recent evals…"
    : !viewerSignedIn ? "Sign in to jump to your recent evals."
    : recent.phase === "error" ? "Recent evals are unavailable right now." : null;

  return createPortal(
    <div className="cp-root" onMouseDown={(e) => { if (e.target === e.currentTarget) hide(); }}>
      <div className="cp-panel" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cp-field">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden className="cp-glass"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
          <input
            ref={inputRef}
            className="cp-input"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[current] ? `${listId}-${current}` : undefined}
            aria-autocomplete="list"
            aria-label="Search pages, actions and recent evals"
            placeholder="Search pages, actions, recent evals…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onInputKey}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="cp-kbd">esc</kbd>
        </div>
        <ul ref={listRef} id={listId} role="listbox" aria-label="Results" className="cp-list">
          {results.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <li key={item.id} role="presentation">
                {header && <div className="cp-group" role="presentation">{header}</div>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === current}
                  data-index={i}
                  className="cp-opt"
                  onMouseMove={() => { if (i !== current) setActive(i); }}
                  onClick={() => go(item)}
                >
                  <span className="cp-opt-icon" aria-hidden data-group={item.group} />
                  <span className="cp-opt-main">
                    <span className="cp-opt-title">{item.title}</span>
                    {item.hint && <span className="cp-opt-hint">{item.hint}</span>}
                  </span>
                  {item.meta && <span className="cp-opt-meta">{item.meta}</span>}
                  <span className="cp-opt-enter" aria-hidden>↵</span>
                </div>
              </li>
            );
          })}
          {results.length === 0 && <li className="cp-none" role="presentation">No matches for “{query}”.</li>}
        </ul>
        <div className="cp-foot">
          <span role="status" aria-live="polite">{status ?? `${results.length} result${results.length === 1 ? "" : "s"}`}</span>
          <span className="cp-keys"><kbd className="cp-kbd">↑</kbd><kbd className="cp-kbd">↓</kbd> move <kbd className="cp-kbd">↵</kbd> open</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** TopBar trigger: shows the shortcut, opens the palette on click. */
export function CommandPaletteTrigger() {
  const [mac, setMac] = useState(true);
  const [ready, setReady] = useState(false);
  useEffect(() => { setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)); setReady(true); }, []);
  return (
    <button type="button" className="cp-trigger" onClick={openCommandPalette} aria-label="Open command palette" aria-keyshortcuts={mac ? "Meta+K" : "Control+K"} data-ready={ready ? "true" : undefined}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
      <span className="cp-trigger-label">Search</span>
      <kbd className="cp-kbd" aria-hidden>{mac ? "⌘" : "Ctrl"} K</kbd>
    </button>
  );
}
