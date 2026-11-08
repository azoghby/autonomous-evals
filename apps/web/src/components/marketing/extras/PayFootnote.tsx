/** "Pay by card or agent-to-agent (x402)" mono footnote with inline SVG glyphs. */
export function PayFootnote() {
  const ico = { width: 18, height: 18, viewBox: "0 0 18 18", fill: "none", stroke: "currentColor", strokeWidth: 1.25, "aria-hidden": true } as const;
  return (
    <p className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[12px] text-subtle">
      <svg {...ico}><rect x="1.5" y="4" width="15" height="10" rx="1" /><path d="M1.5 7.5h15M4 11h3" /></svg>
      <span>Pay by card</span>
      <span aria-hidden className="text-line-3">/</span>
      <svg {...ico}><rect x="1.5" y="5.5" width="5" height="7" rx="1" /><rect x="11.5" y="5.5" width="5" height="7" rx="1" /><path d="M6.5 9h5M9.5 7l2 2-2 2" /></svg>
      <span>agent-to-agent (x402)</span>
    </p>
  );
}
