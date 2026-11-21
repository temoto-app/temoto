/**
 * Recent files (TODO 999). Opens a small window of newest files across the whole PC. Cards stacked in newest-first order behind the front card
 * (the clock is that of "Send later" (989, `ComposerLaterIcon`), and the two sheets of paper stacked vertically are those of the sidebar's Files (`FilesIcon`),
 * so this was given a shape different from both: wave 53 review). Color is `currentColor` only (7.4.1).
 */
export function ComposerRecentIcon(): React.JSX.Element {
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
      <rect x="4" y="10" width="16" height="10" rx="1.5" />
      <path d="M6.5 6.5h11" />
      <path d="M9 3h6" />
    </svg>
  )
}
