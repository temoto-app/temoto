/**
 * "New folder…" (TODO 370, Files heading). A + over a folder (modeled on VS Code's new-folder).
 * Color is `currentColor` only (7.4.1).
 */
export function NewFolderIcon(): React.JSX.Element {
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
      <path d="M12 19.5H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1V12" />
      <path d="M18 15v6M15 18h6" />
    </svg>
  )
}
