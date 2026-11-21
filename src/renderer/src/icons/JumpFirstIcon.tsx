/**
 * "Jump to the first question" (a horizontal line at the top + an upward chevron) of the jump between "my questions" (5.1.4, TODO 53). The shape is the same as qlm's `#jump-first`.
 * The same form as T14 / T17: inline SVG, `fill="none"`, color is `currentColor` only (7.4.1).
 */
export function JumpFirstIcon(): React.JSX.Element {
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
      <path d="M5 5h14" />
      <path d="M12 20V9" />
      <path d="m7 14 5-5 5 5" />
    </svg>
  )
}
