/**
 * Viewer "Back" (TODO 369, wave 20 bundle D). A left arrow, same as VS Code's Go Back.
 * Same format as T14 / T17: inline SVG, `fill="none"`, color only via `currentColor` (7.4.1).
 */
export function ViewerBackIcon(): React.JSX.Element {
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
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  )
}
