/**
 * Send (item 154, 5.5). An upward arrow. Color is `currentColor` (7.4.1); the background color is decided by the caller's
 * CSS (`.composer-send`, `--accent` / `--accent-fg`).
 */
export function ComposerSendIcon(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </svg>
  )
}
