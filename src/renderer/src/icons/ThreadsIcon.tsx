/**
 * The icon of the vertical icon bar (5.3). The reason for making it an **inline SVG React component**:
 * with a `.svg` file the fill / stroke color is embedded inside and falls outside the scope of `test/theme-tokens.test.ts`.
 * Here only `currentColor` is used, and color is left to the parent's CSS variables (7.4.1).
 * As with the other icons, viewBox 24, stroke width 1.5, round ends.
 *
 * TODO 433 (owner request, 2026-10-04): redrawn from a single square-cornered speech bubble (the old shape) to "two overlapping
 * round speech bubbles" (a small one at the lower left and a slightly larger one at the upper right, each with a tail). This is our own design
 * (not copied from another company's icon). The stroke of the back (larger, upper right) bubble is hidden where it overlaps the front (small, lower left)
 * bubble, using the same `<mask>` mechanism as `FileIcon` (TODO 404) (the filled `cut` shape is cut out as black on white),
 * repurposed for a stroke-only outline.
 */
import { useId } from 'react'

/** The small bubble at the lower left (front). A rounded box + a tail extending to the lower left, a single path. */
const FRONT_BUBBLE = 'M15 17a3 3 0 0 1-3 3H6l-3 3V13a3 3 0 0 1 3-3H12a3 3 0 0 1 3 3Z'
/** The large bubble at the upper right (back). It overlaps the front bubble at a corner. */
const BACK_BUBBLE = 'M21 12a3 3 0 0 1-3 3H13l-5 5V6a3 3 0 0 1 3-3H18a3 3 0 0 1 3 3Z'

export function ThreadsIcon(): React.JSX.Element {
  // The `:` / `«»` of useId can be misread inside url(#…), so only alphanumerics are used (the same as FileIcon).
  const maskId = `threads-icon-cut-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect x="0" y="0" width="24" height="24" fill="white" />
        <path d={FRONT_BUBBLE} fill="black" />
      </mask>
      <path d={BACK_BUBBLE} mask={`url(#${maskId})`} />
      <path d={FRONT_BUBBLE} />
    </svg>
  )
}
