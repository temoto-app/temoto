/**
 * Copy for a code block (5.1.2, T17). Two overlapping rectangles.
 * The same form as the four from T14: inline SVG, `fill="none"`, color is `currentColor` only (7.4.1).
 * The button is small, so only the dimensions are 16, and the viewBox and stroke width look the same.
 */
export function CopyIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5.5a1.5 1.5 0 0 0-1.5-1.5h-7A2.5 2.5 0 0 0 4 6.5v7A1.5 1.5 0 0 0 5.5 15" />
    </svg>
  )
}
