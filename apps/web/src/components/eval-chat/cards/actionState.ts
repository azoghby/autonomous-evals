import type { ActionStatus } from "@/lib/eval-chat/types";
import type { Tone } from "../format";

const LABEL: Record<ActionStatus, string> = {
  proposed: "Waiting for you",
  executing: "Starting",
  executed: "Confirmed",
  cancelled: "Cancelled",
  failed: "Failed",
  expired: "Expired",
};
const TONE: Record<ActionStatus, Tone> = { proposed: "accent", executing: "accent", executed: "ok", cancelled: "muted", failed: "danger", expired: "warn" };

export const actionStateLabel = (s: ActionStatus): string => LABEL[s];
export const actionTone = (s: ActionStatus): Tone => TONE[s];
