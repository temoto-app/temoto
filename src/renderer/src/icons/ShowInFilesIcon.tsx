/**
 * Show in aios's Files (TODO 1007). A tree branch drawn inside a sidebar (the left pane).
 * Not made to resemble Show in Finder (`RevealIcon`'s folder + arrow), the magnifier, the clock, or the stacked badge. Color is `currentColor` only (7.4.1).
 */
export function ShowInFilesIcon(): React.JSX.Element {
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
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M11 4v16" />
      <path d="M6.5 8v6.5" />
      <path d="M6.5 11h2" />
      <path d="M6.5 14.5h2" />
    </svg>
  )
}
