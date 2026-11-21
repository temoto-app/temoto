/**
 * "New file…" (TODO 370, Files heading). A + over a sheet of paper (modeled on VS Code's new-file).
 * Color is `currentColor` only (7.4.1).
 */
export function NewFileIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 3.5H7a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h5" />
      <path d="M13 3.5l5 5V12" />
      <path d="M13 3.5v5h5" />
      <path d="M18 15v6M15 18h6" />
    </svg>
  )
}
