"use client";
import { createContext, useContext } from "react";
import type { ChatAction, ChatAttachment, ChatFields } from "./nova-types";

export interface TurnRequest { message?: string; fields?: ChatFields; action?: ChatAction; attachments?: ChatAttachment[] }

export interface NovaActions {
  /** Sends a turn; `display` is the customer line shown immediately. */
  send: (req: TurnRequest, display: string) => void;
  /** Validates and sends files straight from a component's drop zone. */
  sendFiles: (files: FileList | File[]) => Promise<string[]>;
  busy: boolean;
}

const noop: NovaActions = { send: () => {}, sendFiles: async () => [], busy: true };
export const NovaActionsContext = createContext<NovaActions>(noop);
export const useNovaActions = () => useContext(NovaActionsContext);
