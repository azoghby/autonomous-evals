/** Line diff for prompt patch cards (LCS over lines; prompts are small, capped at 400 lines each side). */
import type { PromptPatchCard } from "@/lib/eval-chat/types";

const MAX_LINES = 400;

export function lineDiff(before: string, after: string): PromptPatchCard["lines"] {
  const a = before.split("\n").slice(0, MAX_LINES);
  const b = after.split("\n").slice(0, MAX_LINES);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: PromptPatchCard["lines"] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: " ", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", text: a[i++] });
    else out.push({ op: "+", text: b[j++] });
  }
  while (i < a.length) out.push({ op: "-", text: a[i++] });
  while (j < b.length) out.push({ op: "+", text: b[j++] });
  return out;
}

/** Collapse long unchanged stretches to 2 lines of context around each change. */
export function withContext(lines: PromptPatchCard["lines"], context = 2): PromptPatchCard["lines"] {
  const keep = lines.map((l, idx) => l.op !== " " || lines.slice(Math.max(0, idx - context), idx + context + 1).some((x) => x.op !== " "));
  const out: PromptPatchCard["lines"] = [];
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped) { out.push({ op: " ", text: `… ${skipped} unchanged line${skipped === 1 ? "" : "s"}` }); skipped = 0; }
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ op: " ", text: `… ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  return out;
}

export function promptPatch(current: string | undefined, input: { title: string; rationale: string; addition: string; replace?: string }, applyable: boolean): PromptPatchCard {
  const before = current ?? "";
  const addition = input.addition.trim().slice(0, 4_000);
  const after = input.replace && before.includes(input.replace)
    ? before.replace(input.replace, addition)
    : before ? `${before.trimEnd()}\n\n${addition}` : addition;
  const lines = before ? withContext(lineDiff(before, after)) : after.split("\n").map((text) => ({ op: "+" as const, text }));
  return { title: input.title.slice(0, 120), rationale: input.rationale.slice(0, 600), lines, after, applyable: applyable && Boolean(current) };
}
