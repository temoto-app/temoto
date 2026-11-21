/**
 * "Search in this folder" (TODO 437). A small magnifying glass shown on hover of a folder row in the Files tree.
 * The size is 14px, the same as the adjacent `PathActions` (`RevealIcon` / `CopyIcon`). Color is `currentColor` only (7.4.1).
 */
export function SearchInFolderIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </svg>
  )
}
