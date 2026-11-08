"use client";

import { Button } from "@/components/ui";

export const SPEEDS = [1, 4, 16] as const;
export type Speed = (typeof SPEEDS)[number];

export function Controls({
  playing,
  done,
  speed,
  gapsShortened,
  onToggle,
  onSpeed,
  onSkip,
  onRestart,
}: {
  playing: boolean;
  done: boolean;
  speed: Speed;
  gapsShortened: boolean;
  onToggle: () => void;
  onSpeed: (s: Speed) => void;
  onSkip: () => void;
  onRestart: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
      <Button size="sm" variant="primary" onClick={done ? onRestart : onToggle} aria-label={done ? "Replay" : playing ? "Pause" : "Play"} className="min-w-[72px]">
        {done ? "Replay" : playing ? "Pause" : "Play"}
      </Button>
      <Button size="sm" variant="outline" onClick={onRestart} aria-label="Restart from the beginning">Restart</Button>
      <Button size="sm" variant="ghost" onClick={onSkip} disabled={done} aria-label="Skip to the end">Skip to end</Button>
      <div className="ml-auto flex items-center gap-1" role="group" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={s === speed}
            onClick={() => onSpeed(s)}
            className={`t-data h-8 min-w-9 rounded-[4px] border px-2 transition-colors ${
              s === speed ? "border-accent bg-accent-soft text-fg" : "border-transparent text-muted hover:text-fg"
            }`}
          >
            {s}×
          </button>
        ))}
      </div>
      {gapsShortened ? (
        <p className="t-data basis-full text-subtle">Idle gaps over 3.5s are shortened. Message order and tool latencies are as recorded.</p>
      ) : null}
    </div>
  );
}
