/** Small stroke icons for the Nova chat (16px grid, currentColor). */
import type { SVGProps } from "react";

const base = (p: SVGProps<SVGSVGElement>) => ({ width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...p });

export const IconClip = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l5.8-5.8a2.3 2.3 0 0 1 3.3 3.3L6.4 11.2a1.2 1.2 0 0 1-1.7-1.7L10 4.2" /></svg>;
export const IconArrowUp = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>;
export const IconStop = (p: SVGProps<SVGSVGElement>) => <svg {...base({ ...p, fill: "currentColor", stroke: "none" })}><rect x="4" y="4" width="8" height="8" rx="1" /></svg>;
export const IconX = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="m4 4 8 8M12 4l-8 8" /></svg>;
export const IconCheck = (p: SVGProps<SVGSVGElement>) => <svg {...base({ width: 10, height: 10, ...p })}><path d="m3.5 8.5 3 3 6-7" /></svg>;
export const IconAlert = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M8 2.5 14 13H2L8 2.5ZM8 6.5v3M8 11.3v.2" /></svg>;
export const IconFile = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M9.5 2H4.5v12h7V4L9.5 2ZM9.5 2v2h2" /></svg>;
export const IconExternal = (p: SVGProps<SVGSVGElement>) => <svg {...base({ width: 12, height: 12, ...p })}><path d="M6 3H3v10h10v-3M9 3h4v4M13 3 7 9" /></svg>;
export const IconExpand = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" /></svg>;
export const IconDown = (p: SVGProps<SVGSVGElement>) => <svg {...base({ width: 12, height: 12, ...p })}><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" /></svg>;
export const IconSpark = (p: SVGProps<SVGSVGElement>) => <svg {...base({ width: 14, height: 14, ...p })}><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M12 4l-1.8 1.8M5.8 10.2 4 12" /></svg>;
