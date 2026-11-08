/**
 * Pixelated Scout bunny, approved artwork. Geometry is byte-identical to
 * assets/brand/scout-pixel.svg (16x16 grid, folded right ear, squared face).
 * Static, currentColor, no raster, no remote assets, no animation.
 * Render at 16 or 32px only so every grid cell lands on whole device pixels.
 * Decorative: always paired with a visible text label, so it is hidden from assistive technology.
 */
export const SCOUT_PIXEL_PATH =
  "M4 1H7V7H9V3H10V1H13V2H15V5H13V4H12V7H13V8H14V10H15V13H14V14H12V15H4V14H2V13H1V10H2V8H4V1ZM4 10H6V12H4V10ZM10 10H12V12H10V10ZM7 13H9V14H7V13Z";

export function ScoutMark({ size = 16, className }: { size?: 16 | 32; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={SCOUT_PIXEL_PATH} />
    </svg>
  );
}
