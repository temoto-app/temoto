/**
 * "Jump to the last answer" (a downward chevron + a horizontal line at the bottom) of the jump between "my questions" (5.1.4, TODO 53). The shape is the same as qlm's `#jump-last`.
 * The same form as T14 / T17: inline SVG, `fill="none"`, color is `currentColor` only (7.4.1).
 */
export function JumpLastIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 19h14" />
    </svg>
  )
}
