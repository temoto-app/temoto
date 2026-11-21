/**
 * Viewer "Forward" (TODO 369, wave 20 bundle D). A right arrow, same as VS Code's Go Forward.
 * Same format as T14 / T17: inline SVG, `fill="none"`, color only via `currentColor` (7.4.1).
 */
export function ViewerForwardIcon(): React.JSX.Element {
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
      focusable="false"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  )
}
