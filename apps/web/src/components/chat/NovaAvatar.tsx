import { ROSTER } from "@/components/marketing/team/roster";

export const NOVA = ROSTER.find((a) => a.id === "nova")!;

/** Nova's roster glyph (square + N). `busy` traces the outline while Nova works. */
export function NovaAvatar({ size = 28, busy = false }: { size?: number; busy?: boolean }) {
  return (
    <svg className="nv-avatar" data-busy={busy} viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
      <path className="nv-sq" d="M6 6h28v28H6Z" strokeLinejoin="round" />
      <path className="nv-trace" d="M6 6h28v28H6Z" strokeLinejoin="round" />
      <text x="20" y="25" textAnchor="middle">{NOVA.name.charAt(0)}</text>
    </svg>
  );
}
