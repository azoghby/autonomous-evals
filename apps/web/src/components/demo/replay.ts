import type { DemoEvent, DemoTrial } from "./demo-run-types";

/**
 * Pure playback engine for the /demo replay. No React, no clocks: given a trial and an elapsed
 * playback time (ms at 1x) it returns exactly what should be on screen.
 */

export const STEP_IDS = ["build", "branch", "simulate", "agent", "grade", "verdict"] as const;
export type StepId = (typeof STEP_IDS)[number];

/** Idle gaps between recorded events longer than this are shortened to it (disclosed in the UI). */
export const IDLE_GAP_CAP_MS = 3500;
/** Longest "typing" indicator shown before an event. */
export const TYPING_MS = 900;
/** Pause between the end of the conversation and the first grader check. */
export const GRADE_LEAD_MS = 500;
/** Time between grader checks ticking. */
export const CHECK_TICK_MS = 550;
const PRE_CONVERSATION_MS = 400;
const POST_CONVERSATION_MS = 700;
const VERDICT_LEAD_MS = 500;
const SETUP_MIN_MS = 700;
const SETUP_MAX_MS = 1500;
const SETUP_FALLBACK_MS = 1000;

export type TypingKind = "user" | "assistant" | "tool";

export interface TimelineItem {
  event: DemoEvent;
  /** Playback time (ms at 1x) when the event appears. */
  at: number;
  /** Playback time when its typing / working indicator starts, or null if there was no gap to show it in. */
  typingFrom: number | null;
}

export interface Timeline {
  items: TimelineItem[];
  buildEnd: number;
  branchEnd: number;
  convEnd: number;
  gradeStart: number;
  checkTimes: number[];
  verdictAt: number;
  total: number;
  /** Playback time at which the first write / external tool call lands (else grading start). */
  diffAt: number;
  outboxAt: number;
  /** True when at least one recorded idle gap was shortened. */
  gapsShortened: boolean;
}

export interface Snapshot {
  step: StepId;
  stepIndex: number;
  /** How many timeline items are visible. */
  shown: number;
  typing: TypingKind | null;
  checksShown: number;
  diffRevealed: boolean;
  outboxRevealed: boolean;
  verdictShown: boolean;
  done: boolean;
}

function finiteOr(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** Setup phases are real-world seconds; compress to a watchable 0.7-1.5s. */
export function compressSetup(ms: number | undefined): number {
  const raw = finiteOr(ms, NaN);
  if (!Number.isFinite(raw) || raw <= 0) return SETUP_FALLBACK_MS;
  return Math.min(SETUP_MAX_MS, Math.max(SETUP_MIN_MS, raw / 3));
}

function sortedEvents(events: DemoEvent[] | undefined): DemoEvent[] {
  const list = Array.isArray(events) ? events.filter((e): e is DemoEvent => !!e && typeof e === "object") : [];
  return list
    .map((event, i) => ({ event, i, t: Math.max(0, finiteOr(event.t, 0)) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.event);
}

function isWrite(e: DemoEvent): boolean {
  return e.type === "tool" && e.effect === "write" && !e.error && e.executed !== false;
}
function isExternal(e: DemoEvent): boolean {
  return e.type === "tool" && e.effect === "external" && !e.error && e.executed !== false;
}

export function buildTimeline(
  trial: Pick<DemoTrial, "events" | "checks" | "branchMs">,
  buildMs: number | undefined,
): Timeline {
  const events = sortedEvents(trial.events);
  const buildEnd = compressSetup(buildMs);
  const branchEnd = buildEnd + compressSetup(trial.branchMs);
  const convStart = branchEnd + PRE_CONVERSATION_MS;

  let gapsShortened = false;
  let prevT = 0;
  let prevAt = convStart;
  const items: TimelineItem[] = events.map((event) => {
    const t = Math.max(0, finiteOr(event.t, 0));
    const gap = Math.max(0, t - prevT);
    if (gap > IDLE_GAP_CAP_MS) gapsShortened = true;
    const at = prevAt + Math.min(gap, IDLE_GAP_CAP_MS);
    const room = at - prevAt;
    const typingFrom = room > 450 ? at - Math.min(TYPING_MS, room - 150) : null;
    prevT = t;
    prevAt = at;
    return { event, at, typingFrom };
  });

  const convEnd = prevAt + POST_CONVERSATION_MS;
  const gradeStart = convEnd;
  const checkCount = Array.isArray(trial.checks) ? trial.checks.length : 0;
  const checkTimes = Array.from({ length: checkCount }, (_, i) => gradeStart + GRADE_LEAD_MS + i * CHECK_TICK_MS);
  const gradeEnd = gradeStart + GRADE_LEAD_MS + Math.max(1, checkCount) * CHECK_TICK_MS;
  const verdictAt = gradeEnd + VERDICT_LEAD_MS;

  return {
    items,
    buildEnd,
    branchEnd,
    convEnd,
    gradeStart,
    checkTimes,
    verdictAt,
    total: verdictAt,
    diffAt: items.find((it) => isWrite(it.event))?.at ?? gradeStart,
    outboxAt: items.find((it) => isExternal(it.event))?.at ?? gradeStart,
    gapsShortened,
  };
}

function countVisible(tl: Timeline, elapsed: number): number {
  let n = 0;
  while (n < tl.items.length && tl.items[n].at <= elapsed) n += 1;
  return n;
}

function kindOf(e: DemoEvent): TypingKind {
  return e.type === "user" ? "user" : e.type === "assistant" ? "assistant" : "tool";
}

export function snapshotAt(tl: Timeline, rawElapsed: number): Snapshot {
  const elapsed = Math.min(tl.total, Math.max(0, finiteOr(rawElapsed, 0)));
  const shown = countVisible(tl, elapsed);
  const next = tl.items[shown];
  const inConversation = elapsed >= tl.branchEnd && elapsed < tl.convEnd;
  const typing: TypingKind | null =
    inConversation && next && next.typingFrom !== null && elapsed >= next.typingFrom ? kindOf(next.event) : null;
  const checksShown = tl.checkTimes.filter((t) => t <= elapsed).length;

  let step: StepId;
  if (elapsed < tl.buildEnd) step = "build";
  else if (elapsed < tl.branchEnd) step = "branch";
  else if (elapsed < tl.gradeStart) {
    const last = shown > 0 ? tl.items[shown - 1].event : null;
    const basis = typing ? typing : last ? kindOf(last) : next ? kindOf(next.event) : "user";
    step = basis === "user" ? "simulate" : "agent";
  } else if (elapsed < tl.verdictAt) step = "grade";
  else step = "verdict";

  return {
    step,
    stepIndex: STEP_IDS.indexOf(step),
    shown,
    typing,
    checksShown,
    diffRevealed: elapsed >= tl.diffAt,
    outboxRevealed: elapsed >= tl.outboxAt,
    verdictShown: elapsed >= tl.verdictAt,
    done: elapsed >= tl.total,
  };
}
