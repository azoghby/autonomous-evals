"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ActionResult, ActionStatus, EvalRef } from "@/lib/eval-chat/types";
import { postAction } from "./api";
import { effectiveStatus } from "./format";

type Ctx = {
  evalRef: EvalRef;
  actions: Record<string, ActionResult>;
  record: (r: ActionResult) => void;
};

const ActionsContext = createContext<Ctx | null>(null);

export function ActionsProvider({ evalRef, initial, children }: { evalRef: EvalRef; initial: Record<string, ActionResult>; children: ReactNode }) {
  const [actions, setActions] = useState(initial);
  const record = useCallback((r: ActionResult) => setActions((a) => ({ ...a, [r.actionId]: r })), []);
  const value = useMemo(() => ({ evalRef, actions, record }), [evalRef, actions, record]);
  return <ActionsContext.Provider value={value}>{children}</ActionsContext.Provider>;
}

export type ActionState = {
  status: ActionStatus;
  result: ActionResult | undefined;
  pending: "confirm" | "cancel" | null;
  error: string | null;
  decide: (decision: "confirm" | "cancel") => Promise<void>;
};

/** Per-card action state. Seeds from the history `actions` map so reloads show the settled state. */
export function useAction(card: { actionId: string; status: ActionStatus; expiresAt: string }): ActionState {
  const ctx = useContext(ActionsContext);
  const [pending, setPending] = useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const result = ctx?.actions[card.actionId];
  const status = effectiveStatus(card, result);
  const evalRef = ctx?.evalRef;
  const record = ctx?.record;

  const decide = useCallback(
    async (decision: "confirm" | "cancel") => {
      if (!evalRef || !record) return;
      setPending(decision);
      setError(null);
      try {
        record(await postAction(evalRef, card.actionId, decision));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      } finally {
        setPending(null);
      }
    },
    [evalRef, record, card.actionId],
  );

  return { status, result, pending, error, decide };
}
