import { ImageResponse } from "next/og";

export const alt = "Standard Evals — Agents build your evals";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0A0A0B";
const BLUE = "#2F6BFF";
const BLUE_BRIGHT = "#5B8CFF";

/** Black base, electric-blue light from the top edge, fluted-glass ribs fading downward: the landing hero, as a card. */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: BG, color: "#fff", fontFamily: "sans-serif" }}>
        <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", display: "flex", backgroundImage: "radial-gradient(ellipse 60% 55% at 50% -10%, rgba(47,107,255,0.45), rgba(47,107,255,0.08) 55%, rgba(47,107,255,0) 80%)" }} />
        <div
          style={{
            position: "absolute", top: 0, left: 0, width: "100%", height: "100%", display: "flex",
            backgroundImage: "repeating-linear-gradient(90deg, rgba(255,255,255,0.07) 0px, rgba(255,255,255,0.02) 4px, rgba(0,0,0,0.35) 9px, rgba(255,255,255,0.07) 11px)",
            maskImage: "linear-gradient(to bottom, #000 0%, #000 55%, transparent 100%)",
          }}
        />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", padding: "64px 72px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
              <path d="M2 12c2.5-6 4.5-6 7 0s4.5 6 7 0 3-4 6-2" stroke={BLUE_BRIGHT} strokeWidth="2.2" strokeLinecap="round" />
            </svg>
            Standard Evals
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 128, fontWeight: 600, lineHeight: 0.98, letterSpacing: "-0.05em", flexDirection: "column" }}>
              <span>Agents build</span>
              <span style={{ display: "flex", flexDirection: "column", alignSelf: "flex-start" }}>
                <span>your evals.</span>
                <span style={{ display: "flex", height: 8, width: "100%", marginTop: 4, background: `linear-gradient(90deg, ${BLUE}, ${BLUE_BRIGHT} 50%, ${BLUE})` }} />
              </span>
            </div>
            <div style={{ display: "flex", marginTop: 36, fontSize: 30, color: "#a1a1aa" }}>
              Scoped, quoted, tested by agents. Plans from $0. Quick evals from $49.
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
